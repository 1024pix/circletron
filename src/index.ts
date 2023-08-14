#!/usr/bin/env node

import { readFile } from 'fs'
import { promisify } from 'util'
import axios from 'axios'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { join as pathJoin } from 'path'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'
import { requireEnv } from './env'
import { getBranchpointCommitAndTargetBranch } from './git'
import { spawnGetStdout } from './command'

const CONTINUATION_API_URL = `https://circleci.com/api/v2/pipeline/continue`
const DEFAULT_CONFIG_VERSION = 2.1
const DEFAULT_TARGET_BRANCHES_REGEX = /^(release\/|develop$|main$|master$)/
const DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES = false

const listPackagesCommands = {
  lerna: {
    cmd: 'lerna',
    args: ['list', '--parseable', '--all', '--long']
  },
  npm: {
    cmd: 'npm',
    args: ['list', '--parseable', '--all', '--long']
  }
}

const listPackagesSinceCommands = {
  npm: (changesSinceCommit) => ({
    cmd: 'npm',
    args: ['list', '--parseable', '--all', '--long']
  }),
  lerna: (changesSinceCommit) => ({
    cmd: 'lerna',
    args: [
      'list',
      '--parseable',
      '--all',
      '--long',
      '--since',
      changesSinceCommit
    ]
  })
}

const pReadFile = promisify(readFile)

interface CircleConfig {
  dependencies?: string[]
  [k: string]: unknown
}

interface Package {
  name: string
  circleConfig: CircleConfig
}

interface CircletronConfig {
  runOnlyChangedOnTargetBranches: boolean
  targetBranchesRegex: RegExp
  passTargetBranch: boolean
  packageManager: string
}

async function getPackages(packageManager): Promise<Package[]> {
  const command = listPackagesCommands[packageManager];
  const packageOutput = await spawnGetStdout(command.cmd, command.args)
  const allPackages = await Promise.all(
    packageOutput
      .trim()
      .split('\n')
      .map(async (line) => {
        const [fullPath, name] = line.split(':')
        let circleConfig: CircleConfig | undefined
        try {
          circleConfig = yamlParse((await pReadFile(pathJoin(fullPath, 'circle.yml'))).toString())
        } catch (e) {
          // no circle config, filter below
        }

        return { circleConfig, name }
      }),
  )

  function hasConfig(pkg: { circleConfig?: CircleConfig }): pkg is Package {
    return !!pkg.circleConfig
  }
  return allPackages.filter(hasConfig)
}

/**
 * Get the names of the packages which builds should be triggered for by
 * determing which packages have changed in this branch and consulting
 * .circleci/circletron.yml to packages that should be run due to a dependency
 * changing.
 */
const getTriggerPackages = async (
  packages: Package[],
  config: CircletronConfig,
  branch: string,
  isTargetBranch: boolean,
): Promise<{ triggerPackages: Set<string>; targetBranch: string }> => {
  const changedPackages = new Set<string>()
  const allPackageNames = new Set(packages.map((pkg) => pkg.name))

  let changesSinceCommit: string
  let targetBranch: string | undefined = branch

  if (isTargetBranch) {
    if (config.runOnlyChangedOnTargetBranches) {
      const lastBuildCommit: string | undefined = await getLastSuccessfulBuildRevisionOnBranch(
        branch,
      )

      if (!lastBuildCommit) {
        console.log(`Could not find a previous build on ${branch}, running all pipelines`)
        return { triggerPackages: allPackageNames, targetBranch }
      }

      changesSinceCommit = lastBuildCommit
    } else {
      console.log(`Detected a push from ${branch}, running all pipelines`)
      return { triggerPackages: allPackageNames, targetBranch }
    }
  } else {
    ;({ commit: changesSinceCommit, targetBranch } = await getBranchpointCommitAndTargetBranch(
      config.targetBranchesRegex,
    ))
  }

  console.log("Looking for changes since `%s'", changesSinceCommit)
  const command = listPackagesSinceCommands[config.packageManager](changesSinceCommit);
  const changeOutput = (
    await spawnGetStdout(command.cmd, command.args)
  ).trim()

  if (!changeOutput) {
    console.log('Found no changed packages')
  } else {
    for (const pkg of changeOutput.split('\n')) {
      changedPackages.add(pkg.split(':', 2)[1])
    }

    console.log('Found changes: %O', changedPackages)
  }

  return {
    triggerPackages: new Set(
      Array.from(changedPackages)
        .flatMap((changedPackage) => [
          changedPackage,
          ...packages
            .filter((pkg) => pkg.circleConfig.dependencies?.includes(changedPackage))
            .map((pkg) => pkg.name),
        ])
        .filter((pkg) => allPackageNames.has(pkg)),
    ),
    targetBranch: targetBranch ?? branch,
  }
}

const SKIP_JOB = {
  docker: [{ image: 'busybox:stable' }],
  steps: [
    {
      run: {
        name: 'Jobs not required',
        command: 'echo "Jobs not required"',
      },
    },
  ],
}

async function buildConfiguration(
  packages: Package[],
  triggerPackages: Set<string>,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: Record<string, any> = {}
  try {
    config = yamlParse((await pReadFile('circle.yml')).toString())
  } catch (e) {
    // the root config does not have to exist
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergeObject = (path: string, projectYaml: any): void => {
    for (const [name, value] of Object.entries(projectYaml[path] ?? {})) {
      if (!config[path]) {
        config[path] = {}
      } else if (config[path][name]) {
        throw new Error(`Two ${path} with the same name: ${name}`)
      }
      config[path][name] = value
    }
  }
  if (!config.jobs) {
    config.jobs = {}
  }
  if (!config.version) {
    config.version = DEFAULT_CONFIG_VERSION
  }
  const jobsConfig = config.jobs

  for (const pkg of packages) {
    const { circleConfig } = pkg

    mergeObject('workflows', circleConfig)
    mergeObject('orbs', circleConfig)
    mergeObject('executors', circleConfig)
    mergeObject('commands', circleConfig)

    // jobs may be missing from circle config if all workflow jobs are from orbs
    const jobs = circleConfig.jobs as Record<
      string,
      { conditional?: boolean; parameters?: Record<string, any> }
    >
    for (const [jobName, jobData] of Object.entries(jobs ?? {})) {
      if (jobsConfig[jobName]) {
        throw new Error(`Two jobs with the same name: ${jobName}`)
      }
      if ('conditional' in jobData) {
        const { conditional } = jobData
        delete jobData.conditional
        if (conditional === false) {
          // these jobs are triggered no matter what
          jobsConfig[jobName] = jobData
          continue
        }
      }
      jobsConfig[jobName] = triggerPackages.has(pkg.name)
        ? jobData
        : { ...SKIP_JOB, parameters: jobData.parameters }
    }
  }
  return yamlStringify(config)
}

export async function getCircletronConfig(): Promise<CircletronConfig> {
  let rawConfig: {
    targetBranches?: string
    runOnlyChangedOnTargetBranches?: boolean
    passTargetBranch?: boolean
  } = {}
  try {
    rawConfig = yamlParse((await pReadFile(pathJoin('.circleci', 'circletron.yml'))).toString())
  } catch (e) {
    // circletron.yml is not mandatory
  }

  return {
    runOnlyChangedOnTargetBranches:
      rawConfig.runOnlyChangedOnTargetBranches ?? DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES,
    targetBranchesRegex: rawConfig.targetBranches
      ? new RegExp(rawConfig.targetBranches)
      : DEFAULT_TARGET_BRANCHES_REGEX,
    passTargetBranch: Boolean(rawConfig.passTargetBranch),
    packageManager: rawConfig.packageManager ?? 'lerna',
  }
}

export async function triggerCiJobs(branch: string, continuationKey: string): Promise<void> {
  const circletronConfig = await getCircletronConfig()
  const packages = await getPackages(circletronConfig.packageManager)
  // run all jobs on target branches
  const isTargetBranch = circletronConfig.targetBranchesRegex.test(branch)
  const { triggerPackages, targetBranch } = await getTriggerPackages(
    packages,
    circletronConfig,
    branch,
    isTargetBranch,
  )

  const configuration = await buildConfiguration(packages, triggerPackages)
  const body: {
    'continuation-key': string
    configuration: string
    parameters?: Record<string, string | boolean>
  } = { 'continuation-key': continuationKey, configuration }
  if (circletronConfig.passTargetBranch) {
    body.parameters = { 'target-branch': targetBranch, 'on-target-branch': isTargetBranch }
  }
  console.log('CircleCI configuration:')
  console.log(configuration)

  const response = await axios.post(CONTINUATION_API_URL, body)
  console.log('CircleCI response: %O', response.data)
}

if (require.main === module) {
  const branch = requireEnv('CIRCLE_BRANCH')
  const continuationKey = requireEnv('CIRCLE_CONTINUATION_KEY')

  triggerCiJobs(branch, continuationKey).catch((err) => {
    console.warn('Got error: %O', err)
    process.exit(1)
  })
}
