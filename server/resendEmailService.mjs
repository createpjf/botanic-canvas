import { createHash } from 'node:crypto'

const resendEmailsUrl = 'https://api.resend.com/emails'

const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeResendHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => htmlEscapes[character])
}

function actionLink(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('验证链接不能为空。')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('验证链接格式无效。')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('验证链接协议无效。')
  return parsed.href
}

function idempotencyKey(prefix, value) {
  return `${prefix}/${createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`
}

function emailHtml({ title, intro, actionLabel, link, footer }) {
  const action = link ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr>
        <td bgcolor="#1f4d3a" style="border-radius:6px;background-color:#1f4d3a;">
          <a href="${escapeResendHtml(link)}" style="display:inline-block;padding-top:12px;padding-right:20px;padding-bottom:12px;padding-left:20px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:20px;text-decoration:none;">${escapeResendHtml(actionLabel)}</a>
        </td>
      </tr>
    </table>` : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>${escapeResendHtml(title)}</title>
  </head>
  <body style="margin:0;background-color:#f4f1ea;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f1ea" style="width:100%;background-color:#f4f1ea;">
      <tr>
        <td align="center" style="padding-top:32px;padding-right:16px;padding-bottom:32px;padding-left:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
            <tr>
              <td style="padding-top:32px;padding-right:32px;padding-bottom:32px;padding-left:32px;">
                <p style="margin-top:0;margin-right:0;margin-bottom:24px;margin-left:0;color:#1f4d3a;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;letter-spacing:2px;">BOTANIC</p>
                <h1 style="margin-top:0;margin-right:0;margin-bottom:16px;margin-left:0;color:#1d2b25;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:36px;font-weight:600;">${escapeResendHtml(title)}</h1>
                <p style="margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;color:#4b5a53;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:26px;">${escapeResendHtml(intro)}</p>
                ${action}
                <p style="margin-top:28px;margin-right:0;margin-bottom:0;margin-left:0;color:#7b857f;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;">${escapeResendHtml(footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function providerError(payload, status) {
  const error = new Error(payload?.message || 'Resend 邮件发送失败。')
  error.code = payload?.name || 'RESEND_SEND_FAILED'
  error.status = status
  return error
}

/**
 * Resend 只在服务端启用；未配置时返回 undefined，让现有 Supabase 邮件链路继续工作。
 */
export function createResendEmailService({ apiKey, from, replyTo, fetchImpl = fetch } = {}) {
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const normalizedFrom = typeof from === 'string' ? from.trim() : ''
  const normalizedReplyTo = typeof replyTo === 'string' ? replyTo.trim() : ''
  if (!normalizedApiKey && !normalizedFrom) return undefined
  if (!normalizedApiKey || !normalizedFrom) throw new Error('RESEND_API_KEY 与 RESEND_FROM_EMAIL 必须同时配置。')

  async function send({ to, subject, html, text, key }) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10_000)
    let response
    try {
      response = await fetchImpl(resendEmailsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${normalizedApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'botanic-canvas/1.0',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify({
          from: normalizedFrom,
          to: [to],
          subject,
          html,
          text,
          ...(normalizedReplyTo ? { reply_to: [normalizedReplyTo] } : {}),
        }),
        signal: controller.signal,
      })
    } catch (caught) {
      if (controller.signal.aborted) throw providerError({ message: 'Resend 邮件服务响应超时。' }, 408)
      throw caught
    } finally {
      clearTimeout(timeoutId)
    }
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) throw providerError(payload, response.status)
    if (!payload?.id) throw providerError({ message: 'Resend 未返回邮件 ID。' }, response.status)
    return payload
  }

  return {
    async sendVerificationEmail({ userId, to, actionLink: rawActionLink }) {
      const link = actionLink(rawActionLink)
      return send({
        to,
        subject: '验证你的 Botanic 邮箱',
        html: emailHtml({
          title: '验证你的邮箱',
          intro: '请点击下方按钮验证邮箱，并设置你的 Botanic 工作区密码。',
          actionLabel: '验证邮箱并设置密码',
          link,
          footer: '如果你没有发起这次操作，可以忽略此邮件。',
        }),
        text: `请打开以下链接验证邮箱并设置密码：\n${link}\n\n如果你没有发起这次操作，可以忽略此邮件。`,
        key: idempotencyKey(`botanic-verification/${userId}`, link),
      })
    },

    async sendWelcomeEmail({ userId, to, name }) {
      const displayName = typeof name === 'string' && name.trim() ? name.trim() : '你好'
      return send({
        to,
        subject: '欢迎加入 Botanic',
        html: emailHtml({
          title: `欢迎加入 Botanic，${displayName}`,
          intro: '你的工作区账号已经准备好了。完成邮箱验证和密码设置后，就可以开始管理品牌视觉生产流程。',
          footer: '这是一封账户通知邮件，不需要回复。',
        }),
        text: `欢迎加入 Botanic，${displayName}。\n\n完成邮箱验证和密码设置后，就可以开始管理品牌视觉生产流程。`,
        key: idempotencyKey('botanic-welcome', userId),
      })
    },
  }
}

export async function sendResendInviteEmails({ emailService, userId, email, name, actionLink: rawActionLink, welcome = true }) {
  if (!emailService) return
  await emailService.sendVerificationEmail({ userId, to: email, actionLink: rawActionLink })
  if (welcome) await emailService.sendWelcomeEmail({ userId, to: email, name })
}
