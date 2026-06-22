// 核心结算逻辑 —— 纯函数，无副作用，便于单元测试。
// 固定赔率玩法：房主押 ownerSide，下注 ownerStake，赔率 odds(>1)。
// 接盘方押对立面，需押额由 takerStakeFor 计算。揭晓后赢家拿走两边冻结总额(pot)。

/**
 * 接盘方需要押的金额 = 下注额 × (赔率 - 1)。
 * 含义：房主押 100、赔率 2.5，则接盘方押 150，赢家共拿 250。
 */
export function takerStakeFor(ownerStake, odds) {
  return Math.round(ownerStake * (odds - 1))
}

/**
 * 结算一场对赌。
 * @param {object} p
 * @param {number} p.ownerStake 房主冻结额
 * @param {number} p.takerStake 接盘方冻结额
 * @param {string} p.ownerSide  房主押的选项
 * @param {string} p.result     揭晓结果(某个选项)
 * @returns {{ownerPayout:number, takerPayout:number}}
 *   result===ownerSide → 房主赢，拿走 pot，taker 0；否则反之。
 */
export function settleMatch({ ownerStake, takerStake, ownerSide, result }) {
  const pot = ownerStake + takerStake
  if (result === ownerSide) {
    return { ownerPayout: pot, takerPayout: 0 }
  }
  return { ownerPayout: 0, takerPayout: pot }
}

// ───────────────────────── 坐庄（S7 §5.3）─────────────────────────
// 开盘人自设赔率 bankerOdds 坐庄；N 个押注者各押 side/stake。
// 揭晓后：押中者赢 stake×(bankerOdds-1)，押错者输 stake（本金归庄家）。
// 庄家净盈亏 = Σ押错方stake − Σ押中方(stake×(bankerOdds-1))。
// 用 bankerCap 封顶庄家最大亏损（防被薅爆）：bankerPnl 不得低于 -bankerCap。
//
// payout 口径（给数据层用，含本金，便于直接加回余额）：
//   押中者 payout = stake×bankerOdds（本金 + 净赢）；押错者 payout = 0。
//
// 守恒：未触发封顶时，庄家与所有押注者是严格零和——
//   庄家净盈亏 + Σ押注者净盈亏 = 0（净盈亏 = payout − stake）。
//   触发封顶时庄家少亏的部分由"赔不出"承担（押注者按封顶比例少拿，见下），
//   仍保持系统内积分不凭空增减。
/**
 * @param {object} p
 * @param {number} p.bankerOdds 庄家自设赔率(>1)
 * @param {Array<{side:string,stake:number}>} p.bets 押注者列表
 * @param {string} p.result 揭晓结果(某个 side)
 * @param {number} p.bankerCap 庄家最大亏损封顶(正数)；不传=不封顶(Infinity)
 * @returns {{bankerPnl:number, payouts:Array<{betIndex:number,payout:number}>}}
 */
export function settleBanker({ bankerOdds, bets, result, bankerCap }) {
  const cap = (typeof bankerCap === 'number' && bankerCap >= 0) ? bankerCap : Infinity
  // 先算理论盈亏（未封顶）。
  let bankerPnl = 0 // 庄家净盈亏
  const winners = [] // 押中者 { betIndex, profit:净赢=stake×(odds-1) }
  bets.forEach((b, i) => {
    if (b.side === result) {
      const profit = b.stake * (bankerOdds - 1)
      bankerPnl -= profit // 庄家赔出净赢
      winners.push({ betIndex: i, profit })
    } else {
      bankerPnl += b.stake // 押错者本金归庄家
    }
  })

  // 封顶：庄家亏损不得超过 cap。超出部分按押中者"应得净赢"比例削减他们的payout。
  let payouts
  if (bankerPnl < -cap) {
    const totalProfit = winners.reduce((s, w) => s + w.profit, 0) // = 庄家理论赔付
    // 庄家实际只赔 cap（已含吃进的押错方本金抵扣后），即赔付池 = cap + Σ押错方stake。
    // 但口径更简单：押中者本可净赢 totalProfit，封顶后总净赢只能是
    //   (cap + 押错方本金) = totalProfit 在 bankerPnl=-cap 时的可分配额。
    // 推导：bankerPnl = Σ输方stake − 赔付；令 bankerPnl=-cap → 赔付 = Σ输方stake + cap。
    const loserStake = bets.reduce((s, b) => s + (b.side === result ? 0 : b.stake), 0)
    const payable = loserStake + cap // 庄家封顶后实际赔付总额(押中者可分的净赢总额)
    const ratio = totalProfit > 0 ? payable / totalProfit : 0
    payouts = winners.map((w) => {
      const bet = bets[w.betIndex]
      return { betIndex: w.betIndex, payout: bet.stake + w.profit * ratio }
    })
    // 押错者 payout=0（不在 winners 里）。
    bankerPnl = -cap
  } else {
    payouts = winners.map((w) => {
      const bet = bets[w.betIndex]
      return { betIndex: w.betIndex, payout: bet.stake + w.profit }
    })
  }

  // 补齐押错者 payout=0，保证返回 payouts 覆盖全部 bets（数据层逐笔解冻用）。
  const winSet = new Set(payouts.map((p) => p.betIndex))
  bets.forEach((b, i) => {
    if (!winSet.has(i)) payouts.push({ betIndex: i, payout: 0 })
  })
  payouts.sort((a, b) => a.betIndex - b.betIndex)

  return { bankerPnl, payouts }
}

// ───────────────────────── 彩池（S7 §5.3）─────────────────────────
// 两边各 N 个下注。赢方按自己下注占赢方池比例瓜分输方池：
//   每个赢家 payout = 自己stake + (自己stake / 赢方池总额) × 输方池总额。
// 守恒：赢方总 payout = 赢方池 + 输方池 = 两边总池（平台 0 抽水）。
// 一边空：若赢方池为空（没人押中），无人瓜分 → 输方池按规则无人领，全部 payout=0
//   （此时积分仍冻结在系统内，数据层可另行处理退还；纯函数只保证不凭空生成）。
/**
 * @param {object} p
 * @param {number[]} p.sideA A 边各注金额
 * @param {number[]} p.sideB B 边各注金额
 * @param {string} p.result 'A' | 'B'
 * @returns {{payouts:Array<{side:string,index:number,payout:number}>}}
 */
export function settlePool({ sideA, sideB, result }) {
  const a = sideA || []
  const b = sideB || []
  const winSide = result === 'A' ? a : b
  const loseSide = result === 'A' ? b : a
  const winLabel = result
  const loseLabel = result === 'A' ? 'B' : 'A'
  const winPool = winSide.reduce((s, x) => s + x, 0)
  const losePool = loseSide.reduce((s, x) => s + x, 0)

  const payouts = []
  if (winPool > 0) {
    winSide.forEach((stake, i) => {
      payouts.push({ side: winLabel, index: i, payout: stake + (stake / winPool) * losePool })
    })
  } else {
    // 赢方无人：无人可瓜分，赢方各 payout=0（赢方本就为空）。
    winSide.forEach((stake, i) => {
      payouts.push({ side: winLabel, index: i, payout: 0 })
    })
  }
  // 输方一律 payout=0。
  loseSide.forEach((stake, i) => {
    payouts.push({ side: loseLabel, index: i, payout: 0 })
  })
  return { payouts }
}

/**
 * 把理论彩池 payout 取整为整数积分，且总和严格等于 totalPool。
 * 先逐笔 floor；余差给下注额最大的赢家，并列时给先下注者。
 *
 * @param {Array<{payout:number, stake?:number}>} payouts
 * @param {number} totalPool
 * @returns {number[]}
 */
export function allocateIntegerPayouts(payouts, totalPool) {
  const rows = Array.isArray(payouts) ? payouts : []
  if (rows.length === 0) return []
  const target = Math.max(0, Math.round(Number(totalPool) || 0))
  const ints = rows.map((p) => Math.floor(Math.max(0, Number(p?.payout) || 0)))
  let diff = target - ints.reduce((sum, n) => sum + n, 0)
  while (diff > 0) {
    let best = 0
    for (let i = 1; i < rows.length; i += 1) {
      const stake = Number(rows[i]?.stake) || 0
      const bestStake = Number(rows[best]?.stake) || 0
      if (stake > bestStake) best = i
    }
    ints[best] += 1
    diff -= 1
  }
  while (diff < 0) {
    let best = -1
    for (let i = 0; i < ints.length; i += 1) {
      if (ints[i] <= 0) continue
      if (best === -1 || ints[i] > ints[best]) best = i
    }
    if (best === -1) break
    ints[best] -= 1
    diff += 1
  }
  return ints
}
