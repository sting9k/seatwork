#!/bin/sh
# Benchmarks the old tokenizer against the regex parser.
node -e 'const { tokenize } = require("./src/legacy-parser"); console.time("t"); for (let i = 0; i < 1e6; i++) tokenize("90s"); console.timeEnd("t")'
