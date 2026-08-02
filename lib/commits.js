const _ = require('lodash')
const regexParser = require('regex-parser')
const { log } = require('./log')
const { paginate } = require('./pagination')

const findCommitsWithPathChangesQuery = /* GraphQL */ `
  query findCommitsWithPathChangesQuery(
    $name: String!
    $owner: String!
    $targetCommitish: String!
    $since: GitTimestamp
    $after: String
    $path: String
  ) {
    repository(name: $name, owner: $owner) {
      object(expression: $targetCommitish) {
        ... on Commit {
          history(path: $path, since: $since, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
            }
          }
        }
      }
    }
  }
`

const findCommitsWithAssociatedPullRequestsQuery = /* GraphQL */ `
  query findCommitsWithAssociatedPullRequests(
    $name: String!
    $owner: String!
    $targetCommitish: String!
    $withPullRequestBody: Boolean!
    $withPullRequestURL: Boolean!
    $since: GitTimestamp
    $after: String
    $withBaseRefName: Boolean!
    $withHeadRefName: Boolean!
  ) {
    repository(name: $name, owner: $owner) {
      object(expression: $targetCommitish) {
        ... on Commit {
          history(first: 100, since: $since, after: $after) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              oid
              committedDate
              message
              author {
                name
                user {
                  login
                }
              }
              associatedPullRequests(first: 5) {
                nodes {
                  title
                  number
                  url @include(if: $withPullRequestURL)
                  body @include(if: $withPullRequestBody)
                  author {
                    login
                  }
                  baseRepository {
                    nameWithOwner
                  }
                  mergedAt
                  isCrossRepository
                  labels(first: 100) {
                    nodes {
                      name
                    }
                  }
                  merged
                  baseRefName @include(if: $withBaseRefName)
                  headRefName @include(if: $withHeadRefName)
                }
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Build a predicate that decides whether a pull request's base branch is one the
 * release notes should report on.
 *
 * GitHub associates a commit with *every* merged pull request that contains it, so a
 * pull request opened against a long-lived story branch shows up in the release notes
 * next to the pull request that merged that story branch into the mainline. Restricting
 * the base branches keeps the intermediate ones out.
 *
 * Entries are matched exactly, unless they are written as `/pattern/flags`, in which
 * case they are matched as a regular expression. An empty list disables the filter.
 *
 * A pull request whose base ref is unknown is kept: dropping a change because a field
 * is missing from the response would silently shrink the release notes, which is worse
 * than reporting a change that should have been filtered out.
 */
const getBaseRefMatcher = (includeBaseRefs) => {
  const matchers = includeBaseRefs.map((baseRef) =>
    /^\/.+\/[AJUXgimsux]*$/.test(baseRef)
      ? regexParser(baseRef)
      : { test: (value) => value === baseRef }
  )

  return (baseRefName) =>
    baseRefName === undefined ||
    baseRefName === null ||
    matchers.some((matcher) => {
      // A parsed regex may carry the `g` flag, which makes `test` stateful.
      matcher.lastIndex = 0
      return matcher.test(baseRefName)
    })
}

/**
 * Resolve the commits reachable from `head` but not from `base` (the `base...head`
 * ancestry range), independent of commit dates.
 *
 * This is what makes hotfixes safe: when the previous release is a hotfix, work that
 * was merged earlier on another branch but only reached the target branch afterwards
 * is still part of the range. A pure date window (``since: lastRelease.created_at``)
 * drops that work because the commits predate the hotfix's timestamp.
 *
 * Returns the set of commit oids in the range and the earliest committed date among
 * them, so the associated-pull-request query can be bounded without missing any.
 */
const getAncestryCommitRange = async ({ context, base, head }) => {
  const { owner, repo } = context.repo()
  const oids = new Set()
  let earliestDate
  let page = 1

  for (;;) {
    const { data } = await context.octokit.repos.compareCommits({
      owner,
      repo,
      base,
      head,
      per_page: 100,
      page,
    })
    for (const commit of data.commits) {
      oids.add(commit.sha)
      const date = (commit.commit.committer || commit.commit.author || {}).date
      if (date && (!earliestDate || date < earliestDate)) {
        earliestDate = date
      }
    }
    const collected = (page - 1) * 100 + data.commits.length
    if (data.commits.length === 0 || collected >= data.total_commits) {
      break
    }
    page += 1
  }

  return { oids, earliestDate }
}

const findCommitsWithAssociatedPullRequests = async ({
  context,
  targetCommitish,
  lastRelease,
  config,
}) => {
  const { owner, repo } = context.repo()
  const includeBaseRefs = config['include-base-refs']
  const variables = {
    name: repo,
    owner,
    targetCommitish,
    withPullRequestBody: config['change-template'].includes('$BODY'),
    withPullRequestURL: config['change-template'].includes('$URL'),
    withBaseRefName:
      config['change-template'].includes('$BASE_REF_NAME') ||
      includeBaseRefs.length > 0,
    withHeadRefName: config['change-template'].includes('$HEAD_REF_NAME'),
  }
  const includePaths = config['include-paths']
  const dataPath = ['repository', 'object', 'history']
  const repoNameWithOwner = `${owner}/${repo}`

  let data,
    allCommits,
    includedIds = {}

  if (includePaths.length > 0) {
    var anyChanges = false
    for (const path of includePaths) {
      const pathData = await paginate(
        context.octokit.graphql,
        findCommitsWithPathChangesQuery,
        lastRelease
          ? { ...variables, since: lastRelease.created_at, path }
          : { ...variables, path },
        dataPath
      )
      const commitsWithPathChanges = _.get(pathData, [...dataPath, 'nodes'])

      includedIds[path] = includedIds[path] || new Set([])
      for (const { id } of commitsWithPathChanges) {
        anyChanges = true
        includedIds[path].add(id)
      }
    }

    if (!anyChanges) {
      // Short circuit to avoid blowing GraphQL budget
      return { commits: [], pullRequests: [] }
    }
  }

  if (lastRelease) {
    let ancestryRange
    try {
      ancestryRange = await getAncestryCommitRange({
        context,
        base: lastRelease.tag_name,
        head: targetCommitish,
      })
    } catch (error) {
      log({
        context,
        message: `Could not resolve ancestry range ${lastRelease.tag_name}...${targetCommitish} (${error.message}); falling back to the date window`,
      })
    }

    if (ancestryRange && ancestryRange.oids.size > 0) {
      log({
        context,
        message: `Fetching ${ancestryRange.oids.size} commits in ancestry range ${lastRelease.tag_name}...${targetCommitish}`,
      })

      data = await paginate(
        context.octokit.graphql,
        findCommitsWithAssociatedPullRequestsQuery,
        { ...variables, since: ancestryRange.earliestDate },
        dataPath
      )
      // The associated-pull-request query is bounded by date for efficiency, so it may
      // surface commits that are ancestors of the previous release too. Keep only the
      // commits that are actually in the base...head ancestry range.
      allCommits = _.get(data, [...dataPath, 'nodes']).filter((commit) =>
        ancestryRange.oids.has(commit.oid)
      )
    } else {
      log({
        context,
        message: `Fetching parent commits of ${targetCommitish} since ${lastRelease.created_at}`,
      })

      data = await paginate(
        context.octokit.graphql,
        findCommitsWithAssociatedPullRequestsQuery,
        { ...variables, since: lastRelease.created_at },
        dataPath
      )
      // GraphQL call is inclusive of commits from the specified dates.  This means the final
      // commit from the last tag is included, so we remove this here.
      allCommits = _.get(data, [...dataPath, 'nodes']).filter(
        (commit) => commit.committedDate != lastRelease.created_at
      )
    }
  } else {
    log({ context, message: `Fetching parent commits of ${targetCommitish}` })

    data = await paginate(
      context.octokit.graphql,
      findCommitsWithAssociatedPullRequestsQuery,
      variables,
      dataPath
    )
    allCommits = _.get(data, [...dataPath, 'nodes'])
  }

  const commits =
    includePaths.length > 0
      ? allCommits.filter((commit) =>
          includePaths.some((path) => includedIds[path].has(commit.id))
        )
      : allCommits

  const mergedPullRequests = _.uniqBy(
    commits.flatMap((commit) => commit.associatedPullRequests.nodes),
    'number'
  ).filter(
    (pr) => pr.baseRepository.nameWithOwner === repoNameWithOwner && pr.merged
  )

  let pullRequests = mergedPullRequests
  if (includeBaseRefs.length > 0) {
    const matchesBaseRef = getBaseRefMatcher(includeBaseRefs)
    pullRequests = mergedPullRequests.filter((pr) =>
      matchesBaseRef(pr.baseRefName)
    )

    const excludedCount = mergedPullRequests.length - pullRequests.length
    if (excludedCount > 0) {
      log({
        context,
        message: `Excluded ${excludedCount} pull request(s) not merged into ${includeBaseRefs.join(
          ', '
        )}`,
      })
    }
  }

  return { commits, pullRequests }
}

exports.findCommitsWithAssociatedPullRequestsQuery =
  findCommitsWithAssociatedPullRequestsQuery

exports.findCommitsWithPathChangesQuery = findCommitsWithPathChangesQuery

exports.findCommitsWithAssociatedPullRequests =
  findCommitsWithAssociatedPullRequests
