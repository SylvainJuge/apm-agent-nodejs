/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const truncate = require('unicode-byte-truncate')

const REDACTED = require('../constants').REDACTED
const logging = require('../logging')
const { NoopApmClient } = require('../apm-client/noop-apm-client')
const { isLambdaExecutionEnvironment } = require('../lambda')
const { isAzureFunctionsEnvironment } = require('../instrumentation/azure-functions')

const {
  INTAKE_STRING_MAX_SIZE,
  BOOL_OPTS,
  NUM_OPTS,
  DURATION_OPTS,
  BYTES_OPTS,
  MINUS_ONE_EQUAL_INFINITY,
  ARRAY_OPTS,
  KEY_VALUE_OPTS,
  ENV_TABLE,
  DEFAULTS
} = require('./schema')

const {
  normalizeArrays,
  normalizeBools,
  normalizeBytes,
  normalizeDurationOptions,
  normalizeIgnoreOptions,
  normalizeInfinity,
  normalizeKeyValuePairs,
  normalizeNumbers,
  normalizeElasticsearchCaptureBodyUrls,
  normalizeDisableMetrics,
  normalizeSanitizeFieldNames,
  normalizeCloudProvider,
  normalizeCustomMetricsHistogramBoundaries,
  normalizeTransactionSampleRate,
  normalizeTraceContinuationStrategy,
  normalizeContextManager,
  normalizeSpanStackTraceMinDuration
} = require('./normalizers')

let confFile = loadConfigFile()

// Configure a logger for the agent.
//
// This is separate from `createConfig` to allow the agent to have an early
// logger before `agent.start()` is called.
function configLogger (opts) {
  const logLevel = (
    process.env[ENV_TABLE.logLevel] ||
    (opts && opts.logLevel) ||
    (confFile && confFile.logLevel) ||
    DEFAULTS.logLevel
  )

  // `ELASTIC_APM_LOGGER=false` is provided as a mechanism to *disable* a
  // custom logger for troubleshooting because a wrapped custom logger does
  // not get structured log data.
  // https://www.elastic.co/guide/en/apm/agent/nodejs/current/troubleshooting.html#debug-mode
  let customLogger = null
  if (process.env.ELASTIC_APM_LOGGER !== 'false') {
    customLogger = (
      (opts && opts.logger) ||
      (confFile && confFile.logger)
    )
  }

  return logging.createLogger(logLevel, customLogger)
}

// Create an initial configuration from DEFAULTS. This is used as a stand-in
// for Agent configuration until `agent.start(...)` is called.
function initialConfig (logger) {
  const cfg = Object.assign({}, DEFAULTS)

  // Reproduce the generated properties for `Config`.
  cfg.disableMetricsRegExp = []
  cfg.ignoreUrlStr = []
  cfg.ignoreUrlRegExp = []
  cfg.ignoreUserAgentStr = []
  cfg.ignoreUserAgentRegExp = []
  cfg.elasticsearchCaptureBodyUrlsRegExp = []
  cfg.transactionIgnoreUrlRegExp = []
  cfg.sanitizeFieldNamesRegExp = []
  cfg.ignoreMessageQueuesRegExp = []
  normalize(cfg, logger)

  cfg.transport = new NoopApmClient()

  return cfg
}

function createConfig (opts, logger) {
  return new Config(opts, logger)
}

class Config {
  constructor (opts, logger) {
    this.disableMetricsRegExp = []
    this.ignoreUrlStr = []
    this.ignoreUrlRegExp = []
    this.ignoreUserAgentStr = []
    this.ignoreUserAgentRegExp = []
    this.elasticsearchCaptureBodyUrlsRegExp = []
    this.transactionIgnoreUrlRegExp = []
    this.sanitizeFieldNamesRegExp = []
    this.ignoreMessageQueuesRegExp = []

    const isLambda = isLambdaExecutionEnvironment()
    const envOptions = readEnv()

    // If we didn't find a config file on process boot, but a path to one is
    // provided as a config option, let's instead try to load that
    if (confFile === null && opts && opts.configFile) {
      confFile = loadConfigFile(opts.configFile)
    }

    Object.assign(
      this,
      DEFAULTS, // default options
      confFile, // options read from config file
      opts, // options passed in to agent.start()
      envOptions // options read from environment variables
    )

    // The logger is used later in this function, so create/update it first.
    // Unless a new custom `logger` was provided, we use the one created earlier
    // in `configLogger()`.
    const customLogger = (process.env.ELASTIC_APM_LOGGER === 'false' ? null : this.logger)
    if (!customLogger && logger) {
      logging.setLogLevel(logger, this.logLevel)
      this.logger = logger
    } else {
      this.logger = logging.createLogger(this.logLevel, customLogger)
    }

    // Fallback and validation handling for `serviceName` and `serviceVersion`.
    if (this.serviceName) {
      // A value here means an explicit value was given. Error out if invalid.
      try {
        validateServiceName(this.serviceName)
      } catch (err) {
        this.logger.error('serviceName "%s" is invalid: %s', this.serviceName, err.message)
        this.serviceName = null
      }
    } else {
      if (isLambda) {
        this.serviceName = process.env.AWS_LAMBDA_FUNCTION_NAME
      } else if (isAzureFunctionsEnvironment && process.env.WEBSITE_SITE_NAME) {
        this.serviceName = process.env.WEBSITE_SITE_NAME
      }
      if (this.serviceName) {
        try {
          validateServiceName(this.serviceName)
        } catch (err) {
          this.logger.warn('"%s" is not a valid serviceName: %s', this.serviceName, err.message)
          this.serviceName = null
        }
      }
      if (!this.serviceName) {
        // Zero-conf support: use package.json#name, else
        // `unknown-${service.agent.name}-service`.
        try {
          this.serviceName = serviceNameFromPackageJson()
        } catch (err) {
          this.logger.warn(err.message)
        }
        if (!this.serviceName) {
          this.serviceName = 'unknown-nodejs-service'
        }
      }
    }
    if (this.serviceVersion) {
      // pass
    } else if (isLambda) {
      this.serviceVersion = process.env.AWS_LAMBDA_FUNCTION_VERSION
    } else if (isAzureFunctionsEnvironment && process.env.WEBSITE_SITE_NAME) {
      // Leave this empty. There isn't a meaningful service version field
      // in Azure Functions envvars, and falling back to package.json ends up
      // finding the version of the "azure-functions-core-tools" package.
    } else {
      // Zero-conf support: use package.json#version, if possible.
      try {
        this.serviceVersion = serviceVersionFromPackageJson()
      } catch (err) {
        // pass
      }
    }

    // Warn agent consumer if it passed deprecated options via ENV, start options or config file.
    const configSources = [envOptions, opts, confFile]
    for (let i = 0; i < configSources.length; i++) {
      if (configSources[i] && 'filterHttpHeaders' in configSources[i]) {
        this.logger.warn('the `filterHttpHeaders` config option is deprecated')
      }
    }

    normalize(this, this.logger)

    if (isLambda || isAzureFunctionsEnvironment) {
      // Override some config in AWS Lambda or Azure Functions environments.
      this.metricsInterval = 0
      this.cloudProvider = 'none'
      this.centralConfig = false
    }
    if (this.metricsInterval === 0) {
      this.breakdownMetrics = false
    }
  }

  // Return a reasonably loggable object for this Config instance.
  // Exclude undefined fields and complex objects like `logger`.
  toJSON () {
    const EXCLUDE_FIELDS = {
      logger: true,
      transport: true
    }
    const REDACT_FIELDS = {
      apiKey: true,
      secretToken: true,
      serverUrl: true
    }
    const NICE_REGEXPS_FIELDS = {
      disableMetricsRegExp: true,
      ignoreUrlRegExp: true,
      ignoreUserAgentRegExp: true,
      transactionIgnoreUrlRegExp: true,
      sanitizeFieldNamesRegExp: true,
      ignoreMessageQueuesRegExp: true
    }
    const loggable = {}
    for (const k in this) {
      if (EXCLUDE_FIELDS[k] || this[k] === undefined) {
        // pass
      } else if (REDACT_FIELDS[k]) {
        loggable[k] = REDACTED
      } else if (NICE_REGEXPS_FIELDS[k] && Array.isArray(this[k])) {
        // JSON.stringify() on a RegExp is "{}", which isn't very helpful.
        loggable[k] = this[k].map(r => r instanceof RegExp ? r.toString() : r)
      } else {
        loggable[k] = this[k]
      }
    }
    return loggable
  }
}

function readEnv () {
  var opts = {}
  for (const key of Object.keys(ENV_TABLE)) {
    let env = ENV_TABLE[key]
    if (!Array.isArray(env)) env = [env]
    for (const envKey of env) {
      if (envKey in process.env) {
        opts[key] = process.env[envKey]
      }
    }
  }
  return opts
}

function validateServiceName (s) {
  if (typeof s !== 'string') {
    throw new Error('not a string')
  } else if (!/^[a-zA-Z0-9 _-]+$/.test(s)) {
    throw new Error('contains invalid characters (allowed: a-z, A-Z, 0-9, _, -, <space>)')
  }
}

// findPkgInfo() looks up from the script dir (or cwd) for a "package.json" file
// from which to load the name and version. It returns:
//    {
//      startDir: "<full path to starting dir>",
//      path: "/the/full/path/to/package.json",  // may be null
//      data: {
//        name: "<the package name>",            // may be missing
//        version: "<the package version>"       // may be missing
//      }
//    }
let pkgInfoCache
function findPkgInfo () {
  if (pkgInfoCache === undefined) {
    // Determine a good starting dir from which to look for a "package.json".
    let startDir = require.main && require.main.filename && path.dirname(require.main.filename)
    if (!startDir && process.argv[1]) {
      // 'require.main' is undefined if the agent is preloaded with `node
      // --require elastic-apm-node/... script.js`.
      startDir = path.dirname(process.argv[1])
    }
    if (!startDir) {
      startDir = process.cwd()
    }
    pkgInfoCache = {
      startDir,
      path: null,
      data: {}
    }

    // Look up from the starting dir for a "package.json".
    const { root } = path.parse(startDir)
    let dir = startDir
    while (true) {
      const pj = path.resolve(dir, 'package.json')
      if (fs.existsSync(pj)) {
        pkgInfoCache.path = pj
        break
      }
      if (dir === root) {
        break
      }
      dir = path.dirname(dir)
    }

    // Attempt to load "name" and "version" from the package.json.
    if (pkgInfoCache.path) {
      try {
        const data = JSON.parse(fs.readFileSync(pkgInfoCache.path))
        if (data.name) {
          // For backward compatibility, maintain the trimming done by
          // https://github.com/npm/normalize-package-data#what-normalization-currently-entails
          pkgInfoCache.data.name = data.name.trim()
        }
        if (data.version) {
          pkgInfoCache.data.version = data.version
        }
      } catch (_err) {
        // Silently leave data empty.
      }
    }
  }
  return pkgInfoCache
}

function serviceNameFromPackageJson () {
  const pkg = findPkgInfo()
  if (!pkg.path) {
    throw new Error(`could not infer serviceName: could not find package.json up from ${pkg.startDir}`)
  }
  if (!pkg.data.name) {
    throw new Error(`could not infer serviceName: "${pkg.path}" does not contain a "name"`)
  }
  if (typeof pkg.data.name !== 'string') {
    throw new Error(`could not infer serviceName: "name" in "${pkg.path}" is not a string`)
  }
  let serviceName = pkg.data.name

  // Normalize a namespaced npm package name, '@ns/name', to 'ns-name'.
  const match = /^@([^/]+)\/([^/]+)$/.exec(serviceName)
  if (match) {
    serviceName = match[1] + '-' + match[2]
  }

  // Sanitize, by replacing invalid service name chars with an underscore.
  const SERVICE_NAME_BAD_CHARS = /[^a-zA-Z0-9 _-]/g
  serviceName = serviceName.replace(SERVICE_NAME_BAD_CHARS, '_')

  // Disallow some weird sanitized values. For example, it is better to
  // have the fallback "unknown-{service.agent.name}-service" than "_" or
  // "____" or " ".
  const ALL_NON_ALPHANUMERIC = /^[ _-]*$/
  if (ALL_NON_ALPHANUMERIC.test(serviceName)) {
    serviceName = null
  }
  if (!serviceName) {
    throw new Error(`could not infer serviceName from name="${pkg.data.name}" in "${pkg.path}"`)
  }

  return serviceName
}

function serviceVersionFromPackageJson () {
  const pkg = findPkgInfo()
  if (!pkg.path) {
    throw new Error(`could not infer serviceVersion: could not find package.json up from ${pkg.startDir}`)
  }
  if (!pkg.data.version) {
    throw new Error(`could not infer serviceVersion: "${pkg.path}" does not contain a "version"`)
  }
  if (typeof pkg.data.version !== 'string') {
    throw new Error(`could not infer serviceVersion: "version" in "${pkg.path}" is not a string`)
  }
  return pkg.data.version
}

function normalize (opts, logger) {
  normalizeKeyValuePairs(opts, KEY_VALUE_OPTS, DEFAULTS, logger)
  normalizeNumbers(opts, NUM_OPTS, DEFAULTS, logger)
  normalizeInfinity(opts, MINUS_ONE_EQUAL_INFINITY, DEFAULTS, logger)
  normalizeBytes(opts, BYTES_OPTS, DEFAULTS, logger)
  normalizeArrays(opts, ARRAY_OPTS, DEFAULTS, logger)
  normalizeDurationOptions(opts, DURATION_OPTS, DEFAULTS, logger)
  normalizeBools(opts, BOOL_OPTS, DEFAULTS, logger)
  normalizeIgnoreOptions(opts)
  normalizeElasticsearchCaptureBodyUrls(opts)
  normalizeDisableMetrics(opts)
  normalizeSanitizeFieldNames(opts)
  normalizeContextManager(opts, [], DEFAULTS, logger) // Must be after normalizeBools().
  normalizeCloudProvider(opts, [], DEFAULTS, logger)
  normalizeTransactionSampleRate(opts, [], DEFAULTS, logger)
  normalizeTraceContinuationStrategy(opts, [], DEFAULTS, logger)
  normalizeCustomMetricsHistogramBoundaries(opts, [], DEFAULTS, logger)

  // This must be after `normalizeDurationOptions()` and `normalizeBools()`
  // because it synthesizes the deprecated `spanFramesMinDuration` and
  // `captureSpanStackTraces` options into `spanStackTraceMinDuration`.
  normalizeSpanStackTraceMinDuration(opts, [], DEFAULTS, logger)

  truncateOptions(opts)
}

function truncateOptions (opts) {
  if (opts.serviceVersion) opts.serviceVersion = truncate(String(opts.serviceVersion), INTAKE_STRING_MAX_SIZE)
  if (opts.hostname) opts.hostname = truncate(String(opts.hostname), INTAKE_STRING_MAX_SIZE)
}

function loadConfigFile (configFile) {
  const confPath = path.resolve(configFile || process.env.ELASTIC_APM_CONFIG_FILE || 'elastic-apm-node.js')

  if (fs.existsSync(confPath)) {
    try {
      return require(confPath)
    } catch (err) {
      console.error('Elastic APM initialization error: Can\'t read config file %s', confPath)
      console.error(err.stack)
    }
  }

  return null
}

// Exports.
module.exports = {
  configLogger,
  initialConfig,
  createConfig,
  normalize
}
