import regexParser from 'regex-parser'

/**
 * Builds a predicate that decides whether a pull request's base branch is one the
 * release notes should report on.
 *
 * Entries are matched exactly, unless they are written as `/pattern/flags`, in which
 * case they are matched as a regular expression. Exact matching is deliberate: a base
 * branch is an identifier rather than free text, and substring matching would let
 * `main` select `maintenance/1.x`.
 *
 * A pull request whose base ref is unknown is kept. Dropping a change because a field
 * is missing from the response would silently shrink the release notes, which is worse
 * than reporting a change that should have been filtered out.
 */
export const getBaseRefMatcher = (includeBaseRefs: string[]) => {
  const matchers = includeBaseRefs.map((baseRef) =>
    /^\/.+\/[AJUXgimsux]*$/.test(baseRef)
      ? regexParser(baseRef)
      : { test: (value: string) => value === baseRef },
  )

  return (baseRefName: string | null | undefined) =>
    baseRefName == null ||
    matchers.some((matcher) => {
      // A parsed regex may carry the `g` flag, which makes `test` stateful.
      if (matcher instanceof RegExp) matcher.lastIndex = 0
      return matcher.test(baseRefName)
    })
}
