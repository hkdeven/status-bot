import { test } from 'node:test'
import assert from 'node:assert/strict'
import { echoVerdict, platformOf } from '../src/sources/outlook.js'

const mail = (from, subject) => ({
  from: { emailAddress: { address: from, name: from } },
  subject
})

const allCovered = {
  trello: { covered: true },
  zoho: { covered: true },
  github: { covered: true, repos: ['incquet-dev/IQ-Allied-DMS', 'Allied-Steel-Buildings/manufacturing-tool'] }
}

test('platform senders are recognised', () => {
  assert.equal(platformOf(mail('do-not-reply@trello.com', 'x')), 'trello')
  assert.equal(platformOf(mail('notifications@zohoprojects.com', 'x')), 'zoho')
  assert.equal(platformOf(mail('notifications@github.com', 'x')), 'github')
  assert.equal(platformOf(mail('jay@alliedbuildings.com', 'x')), null)
})

test('notification mail is dropped when the source already reported', () => {
  assert.equal(echoVerdict(mail('do-not-reply@trello.com', 'Bug, post checkout issues'), allCovered), 'echo')
  assert.equal(echoVerdict(mail('notifications@zohoprojects.com', 'Task updated'), allCovered), 'echo')
})

test('notification mail is kept when that source failed or is not connected', () => {
  assert.equal(echoVerdict(mail('do-not-reply@trello.com', 'x'), { trello: { covered: false } }), 'uncovered')
  assert.equal(echoVerdict(mail('notifications@zohoprojects.com', 'x'), {}), 'uncovered')
})

test('github mail is dropped only for repos the digest tracks', () => {
  const tracked = mail('notifications@github.com', '[incquet-dev/IQ-Allied-DMS] Fix drag drop (#482)')
  const untracked = mail('notifications@github.com', '[someone/other-repo] New issue (#1)')
  const noRepo = mail('notifications@github.com', 'Your weekly digest')
  assert.equal(echoVerdict(tracked, allCovered), 'echo')
  assert.equal(echoVerdict(untracked, allCovered), 'uncovered')
  assert.equal(echoVerdict(noRepo, allCovered), 'uncovered')
})

test('repo matching ignores case', () => {
  const m = mail('notifications@github.com', '[Incquet-Dev/IQ-Allied-DMS] something (#5)')
  assert.equal(echoVerdict(m, allCovered), 'echo')
})

test('ordinary mail is untouched by the echo rules', () => {
  assert.equal(echoVerdict(mail('jay@alliedbuildings.com', 'Margin calc question'), allCovered), null)
})
