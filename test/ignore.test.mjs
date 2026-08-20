import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ignoreMatch, DEFAULT_IGNORE } from '../src/sources/outlook.js'

const mail = (from, subject) => ({ from: { emailAddress: { address: from } }, subject })
const label = m => ignoreMatch(m, DEFAULT_IGNORE)

test('the noisy queues are ignored', () => {
  assert.equal(label(mail('support@alliedsteel.zohodesk.com', 'IT has submitted a new ticket')), 'help desk')
  assert.equal(label(mail('no-reply@alliedbuildings.com', "[External] You've been assigned to an incident request")), 'incidents')
  assert.equal(label(mail('no-reply@alliedbuildings.com', '[External] Your daily Field Service digest')), 'field service')
  assert.equal(label(mail('projects@example.com', 'RFI 42 response required')), 'RFI')
  assert.equal(label(mail('logistics@example.com', 'Shipment 8891 tracking number')), 'shipping')
})

test('a colleague writing about the same topics is never ignored', () => {
  assert.equal(label(mail('fduarte@alliedbuildings.com', 'Field Service Module Feedback - tracking')), null)
  assert.equal(label(mail('fduarte@alliedbuildings.com', 'Incident review meeting Thursday')), null)
  assert.equal(label(mail('dhaines@alliedbuildings.com', 'Shipping costs for the Tesla job')), null)
})

test('ignore rules read the subject, never the body', () => {
  const m = mail('fduarte@alliedbuildings.com', 'FS Module feedback')
  m.bodyPreview = 'We should discuss the shipment tracking number and the RFI backlog'
  assert.equal(label(m), null)
})

test('a rule with neither sender nor subject matches nothing', () => {
  assert.equal(ignoreMatch(mail('anyone@example.com', 'anything'), [{ label: 'broken' }]), null)
})
