function includesText(value, keyword) {
  return String(value || '').toLowerCase().includes(keyword)
}

export function searchMarkets({ pmList = [], matches = [], query = '' } = {}) {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return { pm: [], matches: [] }

  return {
    pm: pmList.filter((ev) =>
      includesText(ev.title, keyword) ||
      includesText(ev.enTitle, keyword) ||
      includesText(ev.subcat, keyword) ||
      includesText(ev.category, keyword) ||
      // 子盘问题（中/英）与榜单候选名（如世界杯球队），覆盖"搜队名/搜盘口问题"的真实场景
      (ev.markets || []).some((m) => includesText(m.zhQuestion, keyword) || includesText(m.question, keyword)) ||
      (ev.outright || []).some((r) => includesText(r.zhName, keyword) || includesText(r.name, keyword)),
    ),
    matches: matches.filter((m) =>
      includesText(m.title, keyword) ||
      includesText(m.optionA, keyword) ||
      includesText(m.optionB, keyword),
    ),
  }
}
