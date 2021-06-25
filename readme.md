# circletron

[![build status](https://circleci.com/gh/circletron/circletron.png?style=shield)](https://circleci.com/gh/circletron/circletron)
[![Known Vulnerabilities](https://snyk.io/test/github/circletron/circletron/badge.svg)](https://snyk.io/test/github/circletron/circletron)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)

circletron is a tool to simplify working with monorepos. Currently monorepos managed via lerna are supported.

It allows splitting up `.circleci/config.yml` among subprojects in the monorepo such that each subproject can define its own commands, workflows and jobs. Jobs defined within subpackage specific workflows can then be automatically skipped in branches where no changes were detected.

## How to use

1. Create a minimal `.circleci/config.yml` like this:

```yaml
version: 2.1
setup: true
orbs:
  circletron: circletron/circletron@1.0.2

workflows:
  trigger-jobs:
    jobs:
      - circletron/trigger-jobs
```

2. Optionally create a `circle.yml` in the root of the monorepo. The jobs in this `circle.yml` will always run and any `commands`, `executors` and `orbs` defined in this `circle.yml` will be available in the `circle.yml` of all other subpackages.

3. Create a `circle.yml` in each subpackage within the monorepo which requires automation. The jobs in this circle configuration are run only when there are changes in the respective branch to a file within this subpackage or changes to one of the subpackages that it depends on. `conditional: false` may be added to a job to specify that it must always be run.

4. Optionally create a `.circle/lerna.yml` file to specify dependencies within projects, e.g.

```
dependencies:
  project1:
    - project2
    - project3
```

will cause jobs within `project1` to run when changes are detected in either `project1`, `project2` or `project3`.

## Details

It is useful to set up branch protection rules to prevent code from being merged when a CI job does not pass. When jobs are omitted then the PR will never be mergeable since the job will remain in a `pending` state. For this reason `circletron` will never omit a job that was determined not to be run, instead the job will be replaced wit a simple job that echos "Job is not required" and return a success exit status.

For the following branches all jobs will run:

- main
- master
- develop
- branches starting with `release/`

This will be configurable in a future release.