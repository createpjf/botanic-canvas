

import { lazy, Suspense, type FormEvent, useEffect, useState } from 'react'
import { ProductApiError, clearProductSession, completeProductPasswordSetup, createProductSession, hybridAuthEnabled, productPasswordSetupRequired, readProductSession, serverPersistenceEnabled, supabaseAuthEnabled, type ProductUser } from './lib/productSession'
import { subscribeProductSessionInvalidated } from './lib/productSessionInvalidation'

const CanvasWorkspace = lazy(() => import('./features/canvas/CanvasWorkspace'))

function App() {
  const [state, setState] = useState<'checking' | 'sign-in' | 'password-setup' | 'ready' | 'error'>(() => serverPersistenceEnabled ? 'checking' : 'ready')
  const [user, setUser] = useState<ProductUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [authMethod, setAuthMethod] = useState<'account' | 'legacy'>('account')
  const [needsPasswordSetup] = useState(() => productPasswordSetupRequired())
  const [message, setMessage] = useState('')
  const useLegacyToken = hybridAuthEnabled && authMethod === 'legacy'

  useEffect(() => subscribeProductSessionInvalidated((invalidationMessage) => {
    setUser(null)
    setMessage(invalidationMessage)
    setState('sign-in')
  }), [])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    let active = true
    let settled = false
    // Supabase 本地会话或 Cookie 同步异常时，不能让整个应用永久停在“正在进入”。
    const restoreTimeout = window.setTimeout(() => {
      if (!active || settled) return
      settled = true
      setMessage('登录恢复超时，请重新登录。')
      setState('sign-in')
    }, 32_000)
    void readProductSession()
      .then((session) => {
        if (!active || settled) return
        settled = true
        window.clearTimeout(restoreTimeout)
        if (session) {
          setUser(session)
          setState(needsPasswordSetup ? 'password-setup' : 'ready')
        } else {
          if (needsPasswordSetup) setMessage('邀请链接已失效或已被使用，请让管理员重新发送邀请。')
          setState('sign-in')
        }
      })
      .catch((error) => {
        if (!active || settled) return
        settled = true
        window.clearTimeout(restoreTimeout)
        setMessage(error instanceof Error ? error.message : '无法连接工作区服务。')
        setState('error')
      })
    return () => {
      active = false
      window.clearTimeout(restoreTimeout)
    }
  }, [needsPasswordSetup])

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accessToken.trim() || (!useLegacyToken && supabaseAuthEnabled && !password)) return
    setState('checking')
    setMessage('')
    try {
      const session = await createProductSession(useLegacyToken
        ? { accessToken: accessToken.trim() }
        : supabaseAuthEnabled
        ? { email: accessToken.trim(), password }
        : accessToken.trim())
      setUser(session)
      setAccessToken('')
      setPassword('')
      setState('ready')
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '登录失败，请稍后重试。')
      setState('sign-in')
    }
  }

  const signOut = async () => {
    setMessage('')
    try {
      await clearProductSession()
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '退出失败，请稍后重试。')
    } finally {
      setUser(null)
      setState('sign-in')
    }
  }

  const completePasswordSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8 || password !== passwordConfirmation) return
    setState('checking')
    setMessage('')
    try {
      await completeProductPasswordSetup(password)
      setPassword('')
      setPasswordConfirmation('')
      setState('ready')
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '密码未保存，请稍后重试。')
      setState('password-setup')
    }
  }

  if (state === 'ready') return (
    <Suspense fallback={<main className="product-access" aria-live="polite"><section><span>BOTANIC</span><h1>正在载入工作台…</h1></section></main>}>
      <CanvasWorkspace currentUser={user ?? undefined} onSignOut={serverPersistenceEnabled ? signOut : undefined} />
    </Suspense>
  )

  return (
    <main className="product-access" aria-live="polite">
      <section>
        <span>BOTANIC</span>
        <h1>{state === 'checking' ? '正在进入…' : state === 'password-setup' ? '设置登录密码' : '登录工作台'}</h1>
        {state === 'checking' ? <p>正在同步你的工作区。</p> : (
          state === 'password-setup' ? <form onSubmit={completePasswordSetup}>
            <p>邀请已确认。设置密码后，下次可直接使用邮箱登录。</p>
            <label><span>新密码</span><input autoComplete="new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" /></label>
            <label><span>确认密码</span><input autoComplete="new-password" type="password" minLength={8} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} placeholder="再输入一次" /></label>
            {passwordConfirmation && password !== passwordConfirmation ? <small role="alert">两次输入的密码不一致。</small> : message ? <small role="alert">{message}</small> : null}
            <button type="submit" disabled={password.length < 8 || password !== passwordConfirmation}>保存并进入工作台</button>
          </form> : <form onSubmit={signIn}>
            <p>{useLegacyToken ? '迁移期间仍可使用原访问令牌。' : supabaseAuthEnabled ? '使用工作区账号登录。' : '输入管理员提供的访问令牌。'}</p>
            <label>
              <span>{useLegacyToken ? '访问令牌' : supabaseAuthEnabled ? '邮箱' : '访问令牌'}</span>
              <input autoComplete={useLegacyToken || !supabaseAuthEnabled ? 'current-password' : 'email'} type={useLegacyToken || !supabaseAuthEnabled ? 'password' : 'email'} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={useLegacyToken || !supabaseAuthEnabled ? '粘贴访问令牌' : 'name@company.com'} />
            </label>
            {supabaseAuthEnabled && !useLegacyToken ? <label>
              <span>密码</span>
              <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" />
            </label> : null}
            {message ? <small role="alert">{message}</small> : null}
            <button type="submit">进入工作台</button>
            {hybridAuthEnabled ? <button className="product-access__alternate" type="button" onClick={() => {
              setAuthMethod(useLegacyToken ? 'account' : 'legacy')
              setAccessToken('')
              setPassword('')
              setMessage('')
            }}>{useLegacyToken ? '返回邮箱登录' : '使用旧访问令牌'}</button> : null}
          </form>
        )}
        {user ? <small>{user.name}</small> : null}
      </section>
    </main>
  )
}

export default App
