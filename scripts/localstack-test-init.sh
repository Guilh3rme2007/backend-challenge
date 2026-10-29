#!/bin/sh
set -eu

awslocal sqs create-queue \
  --queue-name wager-transactions-crash-test.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=60
