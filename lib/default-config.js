const { SORT_BY, SORT_DIRECTIONS } = require('./sort-pull-requests')

const DEFAULT_CONFIG = Object.freeze({
  'name-template': '',
  'tag-template': '',
  'tag-prefix': '',
  'change-template': `* $TITLE (#$NUMBER) @$AUTHOR`,
  'change-title-escapes': '',
  'no-changes-template': `* No changes`,
  'version-template': `$MAJOR.$MINOR.$PATCH$PRERELEASE`,
  'version-resolver': {
    major: { labels: [] },
    minor: { labels: [] },
    patch: { labels: [] },
    default: 'patch',
  },
  categories: [],
  'exclude-labels': [],
  'include-labels': [],
  'include-paths': [],
  'exclude-contributors': [],
  'no-contributors-template': 'No contributors',
  replacers: [],
  autolabeler: [],
  'sort-by': SORT_BY.mergedAt,
  'sort-direction': SORT_DIRECTIONS.descending,
  prerelease: false,
  'prerelease-identifier': '',
  'include-pre-releases': false,
  latest: 'true',
  'filter-by-commitish': false,
  commitish: '',
  'category-template': `## $TITLE`,
  header: '',
  footer: '',
})

/**
 * The base branches reported on when a repository does not configure
 * `include-base-refs` itself.
 *
 * Covers both mainline names: a repository releasing from `main` would otherwise get
 * an empty set of changes with no error, which is a hard failure to spot.
 *
 * Deliberately kept out of DEFAULT_CONFIG: `validateSchema` deep-merges
 * DEFAULT_CONFIG with the repository config, and deepmerge concatenates arrays, so a
 * non-empty default there would be appended to a repository's own list instead of
 * being replaced by it. Applied as a Joi default instead, which only fills the key in
 * when the repository omits it.
 */
const DEFAULT_INCLUDE_BASE_REFS = Object.freeze([
  'development',
  'master',
  'main',
])

exports.DEFAULT_CONFIG = DEFAULT_CONFIG
exports.DEFAULT_INCLUDE_BASE_REFS = DEFAULT_INCLUDE_BASE_REFS
