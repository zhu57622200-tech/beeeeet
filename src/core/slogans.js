// 品牌 slogan 体系（2026-06-11 爹地拍板）。
// 主句承水木然「每一分钱都是认知的变现」+ Robin Hanson「Vote on Values, Bet on Beliefs」
// + Alex Tabarrok「A bet is a tax on bullshit」三条源流。
// 口径：输赢的不是钱，是比钱更重要的认知。

export const SLOGAN_MAIN = '你的每一次预测，都是你认知的变现'

// 战斗句：下注/开盘/约人等火药味场合
export const SLOGAN_BATTLE = '口说无凭，下注为证'

// 结算时刻
export const SLOGAN_WIN = '这不是积分，是认知的变现'
export const SLOGAN_LOSE = '亏掉的不是积分，是认知的学费'

// 排行榜
export const SLOGAN_RANK = '榜单排的不是积分，是认知'

// 斗志句池：空状态/加载位轮换曝光
export const SLOGAN_POOL = [
  SLOGAN_MAIN,
  SLOGAN_BATTLE,
  '敢押，才算真的懂',
  '嘴上都是道理，盘上见真章',
  '观点免费，立场千金',
  '积分会清零，认知的高下不会',
  '赢的不是钱，是「我看对了」',
  '吹牛要上税，下注见水位',
  '你赌不赢认知比你高的人',
  '认知差，就是你朋友的提款机',
]

export function randomSlogan() {
  return SLOGAN_POOL[Math.floor(Math.random() * SLOGAN_POOL.length)]
}
