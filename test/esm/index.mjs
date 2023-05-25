/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict'

// Node.js 12+ requires a fully qualified filename
import agent from '../../index.js'

agent.start({
  captureExceptions: false,
  metricsInterval: '0'
})
