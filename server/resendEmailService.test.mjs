import assert from 'node:assert/strict'
import test from 'node:test'
import { createResendEmailService, escapeResendHtml, sendResendInviteEmails } from './resendEmailService.mjs'

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload } }
}

test('Resend 欢迎与验证邮件走服务端 API，并带有防重复发送键', async () => {
  const requests = []
  const emailService = createResendEmailService({
    apiKey: 're_test_secret',
    from: 'Botanic <no-reply@example.com>',
    replyTo: 'support@example.com',
    fetchImpl: async (url, init) => {
      requests.push({ url, init: { ...init, headers: { ...init.headers }, body: JSON.parse(init.body) } })
      return response(200, { id: `email-${requests.length}` })
    },
  })

  await sendResendInviteEmails({
    emailService,
    userId: 'user-1',
    email: 'member@example.com',
    name: '<Member>',
    actionLink: 'https://botanic.example/auth/callback?code=a&next=/workspace',
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.resend.com/emails')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer re_test_secret')
  assert.equal(requests[0].init.headers['User-Agent'], 'botanic-canvas/1.0')
  assert.match(requests[0].init.body.html, /code=a&amp;next=\/workspace/u)
  assert.match(requests[1].init.body.html, /&lt;Member&gt;/u)
  assert.equal(requests[0].init.body.to[0], 'member@example.com')
  assert.equal(requests[0].init.body.reply_to[0], 'support@example.com')
  assert.notEqual(requests[0].init.headers['Idempotency-Key'], requests[1].init.headers['Idempotency-Key'])
  assert.doesNotMatch(JSON.stringify(requests[0].init.body), /re_test_secret/u)
})

test('Resend 配置不完整时 fail closed，未配置时保持关闭', () => {
  assert.equal(createResendEmailService(), undefined)
  assert.throws(() => createResendEmailService({ apiKey: 're_test' }), /必须同时配置/u)
  assert.throws(() => createResendEmailService({ from: 'Botanic <no-reply@example.com>' }), /必须同时配置/u)
  assert.equal(escapeResendHtml('a&<b>'), 'a&amp;&lt;b&gt;')
})

test('Resend 返回错误时保留状态码和错误码，不吞掉失败', async () => {
  const emailService = createResendEmailService({
    apiKey: 're_test',
    from: 'Botanic <no-reply@example.com>',
    fetchImpl: async () => response(422, { name: 'validation_error', message: 'invalid from' }),
  })

  await assert.rejects(
    () => emailService.sendWelcomeEmail({ userId: 'user-1', to: 'member@example.com', name: 'Member' }),
    (error) => error?.status === 422 && error?.code === 'validation_error',
  )
})
