export function findRetiredStageReferences(contents) {
  const references = []

  contents.split('\n').forEach((line, index) => {
    const matchesByIndex = new Map()
    const patterns = [/(?<![A-Za-z0-9])[mM][0-6](?=$|[^a-z0-9])/gu, /[mM][0-6](?=-[a-z])/gu]

    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const before = line.slice(0, match.index)
        const after = line.slice(match.index + match[0].length)
        const hasPlanningSuffix =
          /^(?:-candidate\b|\s+(?:stage|milestone|phase)\b|\s*(?:阶段|里程碑))/iu.test(after)
        const isAppleChip =
          match[0].startsWith('M') &&
          !hasPlanningSuffix &&
          (/(?:Apple\s*)$/u.test(before) ||
            /^U(?:8)?\b/u.test(after) ||
            /^\s+(?:Pro|Max|Ultra)\b/u.test(after))
        if (!isAppleChip) matchesByIndex.set(match.index, match[0])
      }
    }

    for (const [, value] of [...matchesByIndex].sort(([left], [right]) => left - right)) {
      references.push({ line: index + 1, value })
    }
  })

  return references
}
