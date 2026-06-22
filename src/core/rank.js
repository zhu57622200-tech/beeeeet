// 段位纯函数 —— 无副作用，按胜率 + 结算单数门槛给玩家定段位。
// 熟人圈毒舌风：单数不够先叫"新晋赌徒"，单数够了再按胜率分档；
// 胜率极低的直接"反向指标人"(押他对面就稳赢)。
//
// 段位梯度（从低到高，胜率区间为含下不含上，单数门槛叠加）：
//   单数 < 5                         → 新晋赌徒（样本太小，先别吹）
//   胜率 < 30%                       → 反向指标人（反着押他就赢）
//   30% ≤ 胜率 < 45%                 → 青铜赌徒
//   45% ≤ 胜率 < 55%                 → 白银预言家
//   55% ≤ 胜率 < 65%                 → 黄金神算
//   65% ≤ 胜率 < 75%                 → 铂金赌神
//   胜率 ≥ 75% 且单数 ≥ 15           → 料事如神（封神，需足够样本）
//   胜率 ≥ 75% 但单数 < 15           → 铂金赌神（够准但样本还不够封神）

// 单数门槛：低于此只算"新晋赌徒"。
const MIN_SETTLED = 5
// 封神额外样本门槛：单数够多才允许"料事如神"。
const LEGEND_SETTLED = 15

/**
 * 按战绩返回段位。
 * @param {object} p
 * @param {number} p.wins   赢的单数
 * @param {number} p.losses 输的单数
 * @returns {{name:string, color:string, icon:string, winRate:number, settled:number}}
 */
export function getRank({ wins = 0, losses = 0 } = {}) {
  const settled = wins + losses
  const winRate = settled > 0 ? wins / settled : 0

  if (settled < MIN_SETTLED) {
    return tier('新晋赌徒', '#8b909a', '🐣', winRate, settled)
  }
  if (winRate < 0.3) {
    return tier('反向指标人', '#e74c3c', '🤡', winRate, settled)
  }
  if (winRate < 0.45) {
    return tier('青铜赌徒', '#b08d57', '🥉', winRate, settled)
  }
  if (winRate < 0.55) {
    return tier('白银预言家', '#c0c7d0', '🥈', winRate, settled)
  }
  if (winRate < 0.65) {
    return tier('黄金神算', '#f5c518', '🥇', winRate, settled)
  }
  if (winRate < 0.75) {
    return tier('铂金赌神', '#37d4cf', '💎', winRate, settled)
  }
  // 胜率 ≥ 75%
  if (settled >= LEGEND_SETTLED) {
    return tier('料事如神', '#ffd700', '👑', winRate, settled)
  }
  return tier('铂金赌神', '#37d4cf', '💎', winRate, settled)
}

function tier(name, color, icon, winRate, settled) {
  return { name, color, icon, winRate, settled }
}
