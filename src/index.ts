// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE in the project root for license information.

import * as path from 'path'
import * as tscommonFs from '@ts-common/fs'
import * as fs from 'fs'
import * as md from '@ts-common/commonmark-to-markdown'
import * as openApiMd from '@azure/openapi-markdown'
import * as asyncIt from '@ts-common/async-iterator'
import * as jsonParser from '@ts-common/json-parser'
import * as it from '@ts-common/iterator'
import * as json from '@ts-common/json'
import * as stringMap from '@ts-common/string-map'
import * as commonmark from 'commonmark'
import * as cli from './cli'
import * as git from './git'
import * as childProcess from './child-process'
import * as devOps from './dev-ops'
import * as err from './errors'
import * as format from '@azure/swagger-validation-common'
import * as YAML from 'js-yaml'

// tslint:disable-next-line: no-require-imports
import nodeObjectHash = require('node-object-hash')

export { devOps, cli, git, childProcess }

const errorCorrelationId = (error: err.Error) => {
  const toObject = () => {
    // tslint:disable-next-line:switch-default
    switch (error.code) {
      case 'UNREFERENCED_JSON_FILE':
        return { code: error.code, url: error.jsonUrl }
      case 'NO_JSON_FILE_FOUND':
        return { code: error.code, url: error.readMeUrl }
      case 'NOT_AUTOREST_MARKDOWN':
        return { code: error.code, url: error.readMeUrl }
      case 'JSON_PARSE':
        return {
          code: error.code,
          url: error.error.url,
          position: error.error.position,
        }
      case 'CIRCULAR_REFERENCE': {
        return {
          code: error.code,
          url: error.jsonUrl,
        }
      }
      case 'MISSING_README': {
        return {
          code: error.code,
          url: error.folderUrl,
        }
      }
      case 'INCONSISTENT_API_VERSION': {
        return {
          code: error.code,
          url: error.jsonUrl,
        }
      }
      case 'MULTIPLE_API_VERSION': {
        return {
          code: error.code,
          url: error.readMeUrl,
        }
      }
      case 'INVALID_FILE_LOCATION': {
        return {
          code: error.code,
          url: error.jsonUrl,
        }
      }
    }
  }

  return nodeObjectHash().hash(toObject())
}

const markDownIterate = (node: commonmark.Node | null) =>
  it.iterable(function*() {
    // tslint:disable-next-line:no-let
    let i = node
    while (i !== null) {
      yield i
      i = i.next
    }
  })

const isAutoRestMd = (m: md.MarkDownEx) =>
  markDownIterate(m.markDown.firstChild).some(v => {
    if (v.type !== 'block_quote') {
      return false
    }
    const p = v.firstChild
    if (p === null || p.type !== 'paragraph') {
      return false
    }
    const t = p.firstChild
    if (t === null || t.type !== 'text') {
      return false
    }
    return t.literal === 'see https://aka.ms/autorest'
  })

const safeLoad = (content: string) => {
  try {
    return YAML.safeLoad(content)
  } catch (err) {
    return undefined
  }
}

/**
 * @return return undefined indicates not found, otherwise return non-empty string.
 */
export const getDefaultTag = (markDown: commonmark.Node): string | undefined => {
  const startNode = markDown
  const codeBlockMap = openApiMd.getCodeBlocksAndHeadings(startNode)

  const latestHeader = 'Basic Information'
  const headerBlock = codeBlockMap[latestHeader]
  if (headerBlock && headerBlock.literal) {
    const latestDefinition = safeLoad(headerBlock.literal)
    if (latestDefinition && latestDefinition.tag) {
      return latestDefinition.tag
    }
  }
  for (const idx of Object.keys(codeBlockMap)) {
    const block = codeBlockMap[idx]
    if (!block || !block.info || !block.literal || !/^(yaml|json)$/.test(block.info.trim().toLowerCase())) {
      continue
    }
    const latestDefinition = safeLoad(block.literal)
    if (latestDefinition && latestDefinition.tag) {
      return latestDefinition.tag
    }
  }
  return undefined
}

/**
 * @return return undefined indicates not found, otherwise return non-empty string.
 */
export const getVersionFromInputFile = (filePath: string): string | undefined => {
  const apiVersionRegex = /^\d{4}-\d{2}-\d{2}(|-preview)$/
  const segments = filePath.split('/').slice(0, -1)
  if (segments && segments.length > 1) {
    for (const s of segments) {
      if (apiVersionRegex.test(s)) {
        return s
      }
    }
  }
  return undefined
}

export const isContainsMultiVersion = (m: md.MarkDownEx): boolean => {
  const defaultTag = getDefaultTag(m.markDown)
  if (!defaultTag) {
    return false
  }
  const inputFiles = openApiMd.getInputFilesForTag(m.markDown, defaultTag)
  if (inputFiles) {
    const versions = new Set<string>()
    for (const file of inputFiles) {
      const version = getVersionFromInputFile(file)
      if (version) {
        versions.add(version)
        if (versions.size > 1) {
          return true
        }
      }
    }
  }
  return false
}

const jsonParse = (fileName: string, file: string) => {
  // tslint:disable-next-line:readonly-array
  const errors: err.Error[] = []
  const reportError = (e: jsonParser.ParseError) =>
    errors.push({
      code: 'JSON_PARSE',
      message: 'The file is not a valid JSON file.',
      error: e,
      level: 'Error',
      path: fileName,
    })
  const document = jsonParser.parse(fileName, file.toString(), reportError)
  return {
    errors,
    document,
  }
}

const getRefs = (j: json.Json): it.IterableEx<string> => {
  if (json.isObject(j)) {
    return stringMap
      .entries(j)
      .flatMap(([k, v]) => (k === '$ref' && typeof v === 'string' ? it.concat([v]) : getRefs(v)))
  } else if (it.isArray(j)) {
    return it.flatMap(j, getRefs)
  } else {
    return it.empty()
  }
}

type Ref = {
  /**
   * URL of JSON document.
   */
  readonly url: string
  /**
   * JSON pointer.
   */
  readonly pointer: string
}

type Specification = {
  /**
   * Path of `specs` JSON file
   */
  readonly path: string

  /**
   * readme referenced
   */
  readonly readMePath: string

  /**
   * kind
   */
  readonly kind: 'EXAMPLE' | 'SWAGGER'
}

const parseRef = (ref: string): Ref => {
  const i = ref.indexOf('#')
  return i < 0 ? { url: ref, pointer: '' } : { url: ref.substr(0, i), pointer: ref.substr(i + 1) }
}

const getReferencedFileNames = (fileName: string, doc: json.Json) => {
  const dir = path.dirname(fileName)
  return getRefs(doc)
    .map(v => parseRef(v).url)
    .filter(u => u !== '')
    .map(u => path.resolve(path.join(dir, u)))
}

const moveTo = (a: Set<string>, b: Set<string>, key: string): string => {
  b.add(key)
  a.delete(key)
  return key
}

const isExample = (filePath: string): boolean => filePath.split(path.sep).some(name => name === 'examples')

const containsReadme = async (folder: string): Promise<boolean> => {
  const readmePath = path.resolve(folder, 'readme.md')
  return tscommonFs.exists(readmePath)
}

const validateSpecificationAPIVersion = (current: Specification, document: json.JsonObject): it.IterableEx<err.Error> =>
  it.iterable<err.Error>(function*() {
    const info = document.info as json.JsonObject | undefined
    if (info !== undefined) {
      if (!current.path.includes(info.version as string)) {
        yield {
          code: 'INCONSISTENT_API_VERSION',
          level: 'Error',
          message: 'The API version of the swagger is inconsistent with its file path.',
          jsonUrl: current.path,
          path: current.path,
          readMeUrl: current.readMePath,
        }
      }
    }
  })

const validateFileLocation = (current: Specification, document: json.JsonObject): it.IterableEx<err.Error> =>
  it.iterable<err.Error>(function*() {
    const host = document.host as string | undefined
    if (host !== undefined && host === 'management.azure.com' && !current.path.includes('resource-manager')) {
      yield {
        code: 'INVALID_FILE_LOCATION',
        level: 'Warning',
        path: current.path,
        message:
          // tslint:disable-next-line: max-line-length
          'The management plane swagger JSON file does not match its folder path. Make sure management plane swagger located in resource-manager folder',
        jsonUrl: current.path,
        readMeUrl: current.readMePath,
      }
    }
  })

const findTheNearestReadme = async (cwd: string, swaggerPath: string): Promise<string | undefined> => {
  // tslint:disable-next-line: no-let
  let curDir = swaggerPath
  while (curDir !== cwd) {
    if (await containsReadme(curDir)) {
      return curDir
    }
    curDir = path.dirname(curDir)
  }
  return undefined
}

/**
 * Validate each RP folder must have its readme file.
 *
 * @param dir directory path
 */
const validateRPFolderMustContainReadme = (dir: string): asyncIt.AsyncIterableEx<err.Error> =>
  asyncIt.iterable<err.Error>(async function*() {
    const validDirs: ReadonlyArray<string> = ['data-plane', 'resource-manager']
    const ignoredDirs: ReadonlyArray<string> = ['common']
    const allJsonDir = tscommonFs
      .recursiveReaddir(dir)
      .filter(
        filePath =>
          path.extname(filePath) === '.json' &&
          validDirs.some(
            item =>
              filePath.includes(item) && !ignoredDirs.some(ignoredItem => filePath.toLowerCase().includes(ignoredItem)),
          ),
      )
      .map(filePath => path.dirname(filePath))

    const allJsonSet = new Set<string>()
    for await (const item of allJsonDir) {
      if (allJsonSet.has(item)) {
        continue
      }
      allJsonSet.add(item)
      const nearestReadme = await findTheNearestReadme(process.cwd(), item)
      if (nearestReadme === undefined) {
        yield {
          level: 'Error',
          code: 'MISSING_README',
          message: 'Can not find readme.md in the folder. If no readme.md file, it will block SDK generation.',
          path: item,
          folderUrl: item,
        }
      }
    }
  })

/**
 * The function will validate file reference as a directed graph and will detect circular reference.
 * Detect circular reference in a directed graph using colors.
 *
 * + WHITE: Vertex is not precessed yet. Initially all files mentioned in 'readme.md' is in `whiteSet`.
 * + GRAY:  Vertex is being processed (DFS for this vertex has started, but not finished which means that
 * all descendants (ind DFS tree) of this vertex are not processed yet (or this vertex is in function call stack)
 * + BLACK: Vertex and all its descendants are processed
 *
 * For more detail: https://www.geeksforgeeks.org/detect-cycle-direct-graph-using-colors/
 *
 * @param current current file path
 * @param graySet files currently being explored
 * @param blackSet files have been explored
 */
const DFSTraversalValidate = (
  current: Specification,
  graySet: Set<string>,
  blackSet: Set<string>,
): asyncIt.AsyncIterableEx<err.Error> =>
  asyncIt.iterable<err.Error>(async function*() {
    if (!blackSet.has(current.path)) {
      graySet.add(current.path)
    }
    // tslint:disable-next-line:no-let
    let file

    // tslint:disable-next-line:no-try
    try {
      file = await tscommonFs.readFile(current.path)
    } catch (e) {
      yield {
        code: 'NO_JSON_FILE_FOUND',
        message: 'The JSON file is not found but it is referenced from the readme file.',
        readMeUrl: current.readMePath,
        level: 'Error',
        jsonUrl: current.path,
        path: current.path,
      }
      return
    }
    const { errors, document } = jsonParse(current.path, file.toString())
    yield* errors

    if (current.kind === 'SWAGGER' && document !== null) {
      yield* validateSpecificationAPIVersion(current, document as json.JsonObject)
      yield* validateFileLocation(current, document as json.JsonObject)
    }

    // Example file should ignore `$ref` because it's usually meaningless.
    const refFileNames = current.kind === 'SWAGGER' ? getReferencedFileNames(current.path, document) : []
    for (const refFileName of refFileNames) {
      if (graySet.has(refFileName)) {
        yield {
          code: 'CIRCULAR_REFERENCE',
          message: 'The JSON file has a circular reference.',
          readMeUrl: current.readMePath,
          level: 'Warning',
          jsonUrl: current.path,
          path: current.path,
        }
        moveTo(graySet, blackSet, refFileName)
      }

      if (!blackSet.has(refFileName)) {
        yield* DFSTraversalValidate(
          { path: refFileName, readMePath: current.readMePath, kind: isExample(refFileName) ? 'EXAMPLE' : 'SWAGGER' },
          graySet,
          blackSet,
        )
      }
    }
    moveTo(graySet, blackSet, current.path)
  })

/**
 * validate given `readme.md` format
 */
const validateReadMeFile = (readMePath: string): asyncIt.AsyncIterableEx<err.Error> =>
  asyncIt.iterable<err.Error>(async function*() {
    const file = await tscommonFs.readFile(readMePath)
    const m = md.parse(file.toString())
    if (!isAutoRestMd(m)) {
      yield {
        code: 'NOT_AUTOREST_MARKDOWN',
        message: 'The `readme.md` is not an AutoRest markdown file.',
        readMeUrl: readMePath,
        level: 'Error',
        path: readMePath,
        helpUrl:
          // tslint:disable-next-line:max-line-length
          'http://azure.github.io/autorest/user/literate-file-formats/configuration.html#the-file-format',
      }
    }
    if (isContainsMultiVersion(m)) {
      yield {
        code: 'MULTIPLE_API_VERSION',
        message: 'The default tag contains multiple API versions swaggers.',
        readMeUrl: readMePath,
        tag: getDefaultTag(m.markDown),
        path: readMePath,
        level: 'Warning',
      }
    }
  })

/**
 * Validate spec files in two steps:
 * 1. `DFSTraversalValidate`: Analyze specs as a directed graph to detect circular reference and
 *     generate `blackSet` that contains all explored specs.
 * 2.  Get difference set between `allInputFileSet` and `blackSet`, and then report `UNREFERENCED_JSON_FILE` error.
 *
 * @param inputFileSet files referenced from 'readme.md' is the subset of `allInputFileSet`
 * @param allInputFileSet files appear in specification folder.
 */
const validateInputFiles = (
  inputFileSet: Set<Specification>,
  allInputFileSet: Set<Specification>,
): asyncIt.AsyncIterableEx<err.Error> =>
  // tslint:disable-next-line: no-async-without-await
  asyncIt.iterable<err.Error>(async function*() {
    // report errors if the `dir` folder has JSON files where exist circular reference
    const graySet = new Set<string>()
    const blackSet = new Set<string>()
    for (const current of inputFileSet) {
      yield* DFSTraversalValidate(current, graySet, blackSet)
    }

    // report errors if the `dir` folder has JSON files which are not referenced
    yield* asyncIt
      .fromSync(allInputFileSet.values())
      .filter(spec => !blackSet.has(spec.path))
      .map<err.Error>(spec => ({
        code: 'UNREFERENCED_JSON_FILE',
        message:
          spec.kind === 'SWAGGER'
            ? 'The swagger JSON file is not referenced from the readme file.'
            : 'The example JSON file is not referenced from the swagger file.',
        level: 'Error',
        readMeUrl: spec.readMePath,
        jsonUrl: spec.path,
        path: spec.path,
      }))
  })

const getInputFilesFromReadme = (readMePath: string): asyncIt.AsyncIterableEx<Specification> =>
  asyncIt.iterable<Specification>(async function*() {
    const file = await tscommonFs.readFile(readMePath)
    const m = md.parse(file.toString())
    const dir = path.dirname(readMePath)

    yield* openApiMd
      .getInputFiles(m.markDown)
      .map(f => f.replace('$(this-folder)', '.'))
      .uniq()
      .map(f => path.resolve(path.join(dir, ...f.split('\\'))))
      .map<Specification>(f => ({ path: f, readMePath, kind: isExample(f) ? 'EXAMPLE' : 'SWAGGER' }))
  })

const getAllInputFilesUnderReadme = (readMePath: string): asyncIt.AsyncIterableEx<Specification> =>
  // tslint:disable-next-line: no-async-without-await
  asyncIt.iterable<Specification>(async function*() {
    const dir = path.dirname(readMePath)
    yield* tscommonFs
      .recursiveReaddir(dir)
      .filter(filePath => path.extname(filePath) === '.json')
      .map<Specification>(filePath => ({
        path: filePath,
        readMePath,
        kind: isExample(filePath) ? 'EXAMPLE' : 'SWAGGER',
      }))
  })

/**
 * Validate global specification folder and prepare arguments for `validateInputFiles`.
 */
const validateFolder = (dir: string) =>
  asyncIt.iterable<err.Error>(async function*() {
    const allReadMeFiles = tscommonFs.recursiveReaddir(dir).filter(f => path.basename(f).toLowerCase() === 'readme.md')

    yield* validateRPFolderMustContainReadme(dir)

    yield* allReadMeFiles.flatMap(validateReadMeFile)

    const referencedFiles = await allReadMeFiles
      .flatMap(getInputFilesFromReadme)
      .fold((fileSet: Set<Specification>, spec) => {
        fileSet.add(spec)
        return fileSet
      }, new Set<Specification>())

    const allFiles = await allReadMeFiles
      .flatMap(getAllInputFilesUnderReadme)
      .fold((fileSet: Set<Specification>, spec) => {
        fileSet.add(spec)
        return fileSet
      }, new Set<Specification>())
    yield* validateInputFiles(referencedFiles, allFiles)
  })

/**
 * Creates a map of unique errors for the given folder `cwd`.
 */
const avocadoForDir = async (dir: string, exclude: string[]) => {
  const map = new Map<string, err.Error>()
  if (fs.existsSync(dir)) {
    console.log(`avocadoForDir: ${dir}`)
    for await (const e of validateFolder(dir)) {
      map.set(errorCorrelationId(e), e)
    }
  }
  for (const [k, v] of map) {
    if (exclude.some(item => v.path.search(item) !== -1)) {
      map.delete(k)
    }
  }
  return map
}

/**
 * Run Avocado in Azure DevOps for a Pull Request.
 *
 * @param pr Pull Request properties
 * @param exclude path indicate which kind of error should be ignored.
 */
const avocadoForDevOps = (pr: devOps.PullRequestProperties, exclude: string[]): asyncIt.AsyncIterableEx<err.Error> =>
  asyncIt.iterable<err.Error>(async function*() {
    // collect all errors from the 'targetBranch'
    const diffFiles = await pr.diff()
    const changedSwaggerFilePath = diffFiles.map(item => item.path)

    const swaggerParentDirs = new Set<string>()
    changedSwaggerFilePath
      .map(item => path.dirname(path.resolve(pr.workingDir, item)))
      .filter(item => item !== pr.workingDir)
      .every(item => swaggerParentDirs.add(item))
    const readmeDirs = new Set<string>()
    for (const item of swaggerParentDirs) {
      const readmeDir = await findTheNearestReadme(pr.workingDir, item)
      if (readmeDir !== undefined) {
        readmeDirs.add(readmeDir)
      } else if (!exclude.some(excludeItem => item.search(excludeItem) !== -1)) {
        yield {
          level: 'Error',
          code: 'MISSING_README',
          message: 'Can not find readme.md in the folder. If no readme.md file, it will block SDK generation.',
          path: item,
          folderUrl: item,
        }
      }
    }

    for (const dir of readmeDirs) {
      await pr.checkout(pr.targetBranch)
      const targetMap = await avocadoForDir(path.resolve(pr.workingDir, dir), exclude)

      // collect all errors from the 'sourceBranch'
      await pr.checkout(pr.sourceBranch)
      const sourceMap = await avocadoForDir(path.resolve(pr.workingDir, dir), exclude)

      const fileChanges = await pr.diff()

      // remove existing errors.
      /* avocado will directly report it even though it's not a new involved error in the pull request.*/
      for (const e of targetMap.keys()) {
        const error = sourceMap.get(e)
        if (error !== undefined && !devOps.isPRRelatedError(fileChanges, error)) {
          sourceMap.delete(e)
        }
      }

      yield* sourceMap.values()
    }
  })

/**
 * The function validates files in the given `cwd` folder and returns errors.
 */
export const avocado = (config: cli.Config): asyncIt.AsyncIterableEx<err.Error> =>
  asyncIt.iterable<err.Error>(async function*() {
    const pr = await devOps.createPullRequestProperties(config)
    // detect Azure DevOps Pull Request validation.
    // tslint:disable-next-line: no-let
    let exclude = []
    if (config.args && config.args.excludePaths) {
      exclude = config.args.excludePaths
    }
    if (pr !== undefined) {
      yield* avocadoForDevOps(pr, exclude)
    } else {
      // tslint:disable-next-line: no-let
      let dir = '.'
      if (config.args && config.args.dir) {
        dir = config.args.dir
      }
      yield* (await avocadoForDir(path.resolve(config.cwd, dir), exclude)).values()
    }
  })

export const UnifiedPipelineReport = (filePath: string | undefined): cli.Report => ({
  logInfo: (info: any) => {
    // tslint:disable-next-line: no-console
    console.log(info)
  },
  logError: (error: Error) => {
    console.log(error.stack)
    if (filePath !== undefined) {
      const result: format.RawMessageRecord = {
        type: 'Raw',
        level: 'Error',
        // tslint:disable-next-line: no-non-null-assertion
        message: error.stack!,
        time: new Date(),
      }
      fs.appendFileSync(filePath, JSON.stringify(result) + '\n')
    }
  },
  logResult: (error: err.Error) => {
    console.log(JSON.stringify(error))
    if (filePath !== undefined) {
      const result: format.ResultMessageRecord = {
        type: 'Result',
        level: error.level,
        code: error.code,
        message: error.message,
        docUrl: `https://github.com/Azure/avocado/blob/master/README.md#${error.code}`,
        time: new Date(),
        paths: err.getPathInfoFromError(error),
      }
      fs.appendFileSync(filePath, JSON.stringify(result) + '\n')
    }
  },
})
