#!/bin/sh
set -eu

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)"

REDRIVE_POLICY="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")"
REDRIVE_POLICY_ESCAPED="$(printf '%s' "$REDRIVE_POLICY" | sed 's/"/\\"/g')"
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"${REDRIVE_POLICY_ESCAPED}\"}"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
