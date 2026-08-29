

import { lazy, Suspense, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { ProductLanding } from './components/ProductLanding'
import { useDialogFocusTrap } from './components/useDialogFocusTrap'
import { useRestoreFocus } from './components/motionPresence'
import { workspaceHash, workspaceLocationFromHash } from './features/canvas/canvasWorkspaceNavigation'
import { cleanProductAuthUrl, hasProductAuthCallbackError } from './lib/authFlow'
import { clearProductSession, completeProductPasswordSetup, createProductSession, hybridAuthEnabled, productPasswordSetupRequired, readProductSession, requestProductPasswordReset, serverPersistenceEnabled, supabaseAuthEnabled, type ProductUser } from './lib/productSession'
import { subscribeProductSessionInvalidated } from './lib/productSessionInvalidation'
import { localizeProductError, readProductLocale } from './i18n/core'
import { LanguageSwitcher, useProductI18n } from './i18n/react'
import { formatReleaseLabel, isStaleRelease, readLocalRelease, subscribePublishedRelease, type BotanicRelease } from './lib/releaseGate'
import { isProductStatusPath } from './domain/statusPage'

const CanvasWorkspace = lazy(() => import('./features/canvas/CanvasWorkspace'))
const StatusWorkspace = lazy(() => import('./features/status/StatusWorkspace'))

type ProductAppState = 'checking' | 'landing' | 'sign-in' | 'password-reset' | 'password-setup' | 'ready' | 'error'

const productAccessCopy = {
  'zh-CN': {
    loadingWorkspace: '正在载入工作台…',
    checkingTitle: '正在进入…',
    passwordSetupTitle: '设置登录密码',
    signInTitle: '登录工作台',
    passwordResetTitle: '找回登录密码',
    syncing: '正在同步你的工作区。',
    inviteConfirmed: '邀请已确认。设置密码后，下次可直接使用邮箱登录。',
    newPassword: '新密码',
    confirmPassword: '确认密码',
    passwordMinimum: '至少 8 个字符',
    passwordAgain: '再输入一次',
    passwordMismatch: '两次输入的密码不一致。',
    saveAndEnter: '保存并进入工作台',
    legacyDescription: '迁移期间仍可使用原访问令牌。',
    accountDescription: '使用工作区账号登录。',
    tokenDescription: '输入管理员提供的访问令牌。',
    token: '访问令牌',
    email: '邮箱',
    password: '密码',
    tokenPlaceholder: '粘贴访问令牌',
    passwordPlaceholder: '输入密码',
    passwordResetDescription: '输入工作区邮箱，我们会发送一封安全的恢复邮件。',
    forgotPassword: '忘记密码？',
    sendResetLink: '发送恢复邮件',
    backToSignIn: '返回邮箱登录',
    passwordResetSent: '如果该邮箱已加入工作区，恢复链接将很快发送。请检查收件箱和垃圾邮件。',
    enterWorkspace: '进入工作台',
    backToEmail: '返回邮箱登录',
    useLegacyToken: '使用旧访问令牌',
    backToProduct: '返回产品介绍',
    restoreTimeout: '登录恢复超时，请重新登录。',
    inviteExpired: '邀请链接已失效或已被使用，请让管理员重新发送邀请。',
    connectionFailed: '无法连接工作区服务。',
    signInFailed: '登录失败，请稍后重试。',
    signOutFailed: '退出失败，请稍后重试。',
    passwordSaveFailed: '密码未保存，请稍后重试。',
    releaseTitle: '发现新版本',
    releaseAction: '立即刷新',
  },
  en: {
    loadingWorkspace: 'Loading workspace…',
    checkingTitle: 'Signing in…',
    passwordSetupTitle: 'Set your password',
    signInTitle: 'Sign in to Botanic',
    passwordResetTitle: 'Recover your password',
    syncing: 'Syncing your workspace.',
    inviteConfirmed: 'Your invitation is confirmed. Set a password to sign in with email next time.',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    passwordMinimum: 'At least 8 characters',
    passwordAgain: 'Enter it again',
    passwordMismatch: 'The passwords do not match.',
    saveAndEnter: 'Save and open workspace',
    legacyDescription: 'Your previous access token remains available during migration.',
    accountDescription: 'Sign in with your workspace account.',
    tokenDescription: 'Enter the access token provided by your administrator.',
    token: 'Access token',
    email: 'Email',
    password: 'Password',
    tokenPlaceholder: 'Paste access token',
    passwordPlaceholder: 'Enter password',
    passwordResetDescription: 'Enter your workspace email and we will send a secure recovery link.',
    forgotPassword: 'Forgot password?',
    sendResetLink: 'Send recovery email',
    backToSignIn: 'Back to email sign-in',
    passwordResetSent: 'If this email belongs to the workspace, a recovery link will arrive shortly. Check your inbox and spam folder.',
    enterWorkspace: 'Open workspace',
    backToEmail: 'Back to email sign-in',
    useLegacyToken: 'Use previous access token',
    backToProduct: 'Back to product overview',
    restoreTimeout: 'Session restore timed out. Please sign in again.',
    inviteExpired: 'This invitation has expired or was already used. Ask an administrator for a new invitation.',
    connectionFailed: 'Unable to connect to the workspace service.',
    signInFailed: 'Sign-in failed. Please try again.',
    signOutFailed: 'Sign-out failed. Please try again.',
    passwordSaveFailed: 'Your password was not saved. Please try again.',
    releaseTitle: 'A new version is available',
    releaseAction: 'Refresh now',
  },
} as const

function currentProductAccessCopy() {
  return productAccessCopy[readProductLocale()]
}

function ProductAppFrame({ children }: { children: ReactNode }) {
  const { locale } = useProductI18n()
  const accessCopy = productAccessCopy[locale]
  const localRelease = useMemo(() => readLocalRelease(), [])
  const [publishedRelease, setPublishedRelease] = useState<BotanicRelease | null>(null)
  const stale = isStaleRelease(localRelease, publishedRelease)
  const gateRef = useDialogFocusTrap(stale)

  useEffect(() => subscribePublishedRelease({
    enabled: import.meta.env.PROD,
    onRelease: setPublishedRelease,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  }), [])

  return (
    <>
      {children}
      {stale && publishedRelease ? (
        <main className="product-access product-access--overlay product-access--release-gate">
          <section ref={gateRef} role="alertdialog" aria-modal="true" aria-labelledby="release-gate-title">
            <span>BOTANIC</span>
            <h1 id="release-gate-title">{accessCopy.releaseTitle}</h1>
            <p>v{publishedRelease.version}</p>
            <form onSubmit={(event) => { event.preventDefault(); window.location.reload() }}>
              <button type="submit">{accessCopy.releaseAction}</button>
            </form>
          </section>
        </main>
      ) : null}
    </>
  )
}

function workspaceRouteRequested(hash: string) {
  if (typeof window !== 'undefined' && isProductStatusPath(window.location.pathname)) return false
  return workspaceLocationFromHash(hash) !== null
}

function replaceBrowserHash(hash = '') {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`)
}

function prepareWorkspaceLocation(preserveDeepLink = false) {
  if (typeof window === 'undefined') return
  const currentLocation = workspaceLocationFromHash(window.location.hash)
  replaceBrowserHash(preserveDeepLink && currentLocation ? workspaceHash(currentLocation) : '#/projects')
}

function clearWorkspaceLocation() {
  if (typeof window === 'undefined' || !workspaceRouteRequested(window.location.hash)) return
  replaceBrowserHash()
}

function App() {
  const { locale } = useProductI18n()
  const [state, setState] = useState<ProductAppState>(() => {
    const workspaceRequested = typeof window !== 'undefined' && workspaceRouteRequested(window.location.hash)
    if (serverPersistenceEnabled && workspaceRequested) return 'checking'
    return workspaceRequested ? 'ready' : 'landing'
  })
  const [user, setUser] = useState<ProductUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [passwordResetBusy, setPasswordResetBusy] = useState(false)
  const [passwordResetSent, setPasswordResetSent] = useState(false)
  const [authMethod, setAuthMethod] = useState<'account' | 'legacy'>('account')
  const [needsPasswordSetup] = useState(() => productPasswordSetupRequired())
  const [authCallbackFailed] = useState(() => typeof window !== 'undefined' && hasProductAuthCallbackError(window.location))
  const [message, setMessage] = useState('')
  const [accessOverlayOpen, setAccessOverlayOpen] = useState(() => authCallbackFailed)
  const intendedWorkspaceHashRef = useRef<string | null>(typeof window === 'undefined'
    ? null
    : (() => {
        const location = workspaceLocationFromHash(window.location.hash)
        return location ? workspaceHash(location) : null
      })())
  const sessionRestoreRunRef = useRef(0)
  const useLegacyToken = hybridAuthEnabled && authMethod === 'legacy'
  const accessCopy = productAccessCopy[locale]
  const accessDialogRef = useDialogFocusTrap(accessOverlayOpen)
  useRestoreFocus(accessOverlayOpen)

  useEffect(() => subscribeProductSessionInvalidated((invalidationMessage) => {
    const location = workspaceLocationFromHash(window.location.hash)
    intendedWorkspaceHashRef.current = location ? workspaceHash(location) : null
    setUser(null)
    setMessage(readProductLocale() === 'en' ? 'Your session expired. Sign in again.' : invalidationMessage)
    clearWorkspaceLocation()
    setAccessOverlayOpen(true)
    setState('sign-in')
  }), [])

  useEffect(() => {
    const normalizeWorkspaceRoute = () => {
      const location = workspaceLocationFromHash(window.location.hash)
      if (location && window.location.hash !== workspaceHash(location)) prepareWorkspaceLocation(true)
    }
    normalizeWorkspaceRoute()
    window.addEventListener('hashchange', normalizeWorkspaceRoute)
    return () => window.removeEventListener('hashchange', normalizeWorkspaceRoute)
  }, [])

  useEffect(() => {
    if (!accessOverlayOpen || state === 'checking') return
    const closeAccess = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setAccessOverlayOpen(false)
      setMessage('')
      setState('landing')
    }
    window.addEventListener('keydown', closeAccess)
    return () => window.removeEventListener('keydown', closeAccess)
  }, [accessOverlayOpen, state])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    if (authCallbackFailed) window.history.replaceState(null, '', cleanProductAuthUrl(window.location.href))
    const restoreRun = ++sessionRestoreRunRef.current
    const workspaceRequestedAtStart = workspaceRouteRequested(window.location.hash)
    let active = true
    let settled = false
    const restoreIsCurrent = () => active && !settled && sessionRestoreRunRef.current === restoreRun
    // Supabase 本地会话或 Cookie 同步异常时，不能让整个应用永久停在“正在进入”。
    const restoreTimeout = window.setTimeout(() => {
      if (!restoreIsCurrent()) return
      settled = true
      setMessage(currentProductAccessCopy().restoreTimeout)
      if (workspaceRequestedAtStart || needsPasswordSetup || authCallbackFailed) {
        setAccessOverlayOpen(true)
        setState('sign-in')
      } else {
        setState('landing')
      }
    }, 32_000)
    void readProductSession()
      .then((session) => {
        if (!restoreIsCurrent()) return
        settled = true
        window.clearTimeout(restoreTimeout)
        if (session) {
          setUser(session)
          if (needsPasswordSetup) {
            setState('password-setup')
          } else if (workspaceRouteRequested(window.location.hash)) {
            prepareWorkspaceLocation(true)
            setState('ready')
          } else {
            setState('landing')
          }
        } else {
          if (needsPasswordSetup || authCallbackFailed) setMessage(currentProductAccessCopy().inviteExpired)
          if (needsPasswordSetup || authCallbackFailed) setAccessOverlayOpen(true)
          setState(needsPasswordSetup || authCallbackFailed ? 'sign-in' : 'landing')
        }
      })
      .catch((error) => {
        if (!restoreIsCurrent()) return
        settled = true
        window.clearTimeout(restoreTimeout)
        setMessage(localizeProductError(error, readProductLocale(), {
          'zh-CN': currentProductAccessCopy().connectionFailed,
          en: productAccessCopy.en.connectionFailed,
        }))
        if (workspaceRequestedAtStart || needsPasswordSetup || authCallbackFailed) {
          setAccessOverlayOpen(true)
          setState('sign-in')
        } else {
          setState('landing')
        }
      })
    return () => {
      active = false
      window.clearTimeout(restoreTimeout)
    }
  }, [authCallbackFailed, needsPasswordSetup])

  const openIntendedWorkspace = () => {
    if (typeof window === 'undefined') return
    const currentLocation = workspaceLocationFromHash(window.location.hash)
    const targetHash = currentLocation
      ? workspaceHash(currentLocation)
      : intendedWorkspaceHashRef.current ?? '#/projects'
    intendedWorkspaceHashRef.current = null
    if (isProductStatusPath(window.location.pathname)) {
      window.history.replaceState(window.history.state, '', `/${window.location.search}${targetHash}`)
      return
    }
    replaceBrowserHash(targetHash)
  }

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accessToken.trim() || (!useLegacyToken && supabaseAuthEnabled && !password)) return
    sessionRestoreRunRef.current += 1
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
      openIntendedWorkspace()
      setAccessOverlayOpen(false)
      setState('ready')
    } catch (error) {
      setMessage(localizeProductError(error, locale, { 'zh-CN': accessCopy.signInFailed, en: accessCopy.signInFailed }))
      setState('sign-in')
    }
  }

  const signOut = async () => {
    sessionRestoreRunRef.current += 1
    setMessage('')
    try {
      await clearProductSession()
    } catch (error) {
      setMessage(localizeProductError(error, locale, { 'zh-CN': accessCopy.signOutFailed, en: accessCopy.signOutFailed }))
    } finally {
      setUser(null)
      intendedWorkspaceHashRef.current = null
      clearWorkspaceLocation()
      setAccessOverlayOpen(false)
      setState('landing')
    }
  }

  const completePasswordSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8 || password !== passwordConfirmation) return
    sessionRestoreRunRef.current += 1
    setState('checking')
    setMessage('')
    try {
      await completeProductPasswordSetup(password)
      setPassword('')
      setPasswordConfirmation('')
      openIntendedWorkspace()
      setState('ready')
    } catch (error) {
      setMessage(localizeProductError(error, locale, { 'zh-CN': accessCopy.passwordSaveFailed, en: accessCopy.passwordSaveFailed }))
      setState('password-setup')
    }
  }

  const requestPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accessToken.trim() || passwordResetBusy) return
    setPasswordResetBusy(true)
    setPasswordResetSent(false)
    setMessage('')
    try {
      await requestProductPasswordReset(accessToken)
      setPasswordResetSent(true)
      setMessage(accessCopy.passwordResetSent)
    } catch (error) {
      setMessage(localizeProductError(error, locale, {
        'zh-CN': accessCopy.signInFailed,
        en: accessCopy.signInFailed,
      }))
    } finally {
      setPasswordResetBusy(false)
    }
  }

  const enterWorkspace = () => {
    sessionRestoreRunRef.current += 1
    setMessage('')
    if (user || !serverPersistenceEnabled) {
      openIntendedWorkspace()
      setAccessOverlayOpen(false)
      setState('ready')
      return
    }
    setAccessOverlayOpen(true)
    setState('sign-in')
  }

  const returnToLanding = () => {
    sessionRestoreRunRef.current += 1
    setAccessOverlayOpen(false)
    setAccessToken('')
    setPassword('')
    setPasswordResetSent(false)
    setMessage('')
    intendedWorkspaceHashRef.current = null
    if (typeof window !== 'undefined' && isProductStatusPath(window.location.pathname)) {
      window.history.replaceState(window.history.state, '', '/')
    }
    clearWorkspaceLocation()
    setState('landing')
  }

  const releaseLabel = formatReleaseLabel(readLocalRelease())
  const accessIsDialog = accessOverlayOpen && (state === 'sign-in' || state === 'password-reset' || state === 'checking' || state === 'error')
  const statusPage = typeof window !== 'undefined' && isProductStatusPath(window.location.pathname)
  const accessOverlay = (
    <main className={`product-access${accessIsDialog ? ' product-access--overlay' : ''}`} aria-live="polite">
      <section
        ref={accessIsDialog ? accessDialogRef : undefined}
        role={accessIsDialog ? 'dialog' : undefined}
        aria-modal={accessIsDialog ? true : undefined}
        aria-labelledby="product-access-title"
      >
        <span>BOTANIC</span>
        <LanguageSwitcher className="product-access__language" />
        <h1 id="product-access-title">{state === 'checking' ? accessCopy.checkingTitle : state === 'password-setup' ? accessCopy.passwordSetupTitle : state === 'password-reset' ? accessCopy.passwordResetTitle : accessCopy.signInTitle}</h1>
        {state === 'checking' ? <p>{accessCopy.syncing}</p> : (
          state === 'password-setup' ? <form onSubmit={completePasswordSetup}>
            <p>{accessCopy.inviteConfirmed}</p>
            <label><span>{accessCopy.newPassword}</span><input autoComplete="new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={accessCopy.passwordMinimum} /></label>
            <label><span>{accessCopy.confirmPassword}</span><input autoComplete="new-password" type="password" minLength={8} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} placeholder={accessCopy.passwordAgain} /></label>
            {passwordConfirmation && password !== passwordConfirmation ? <small role="alert">{accessCopy.passwordMismatch}</small> : message ? <small role="alert">{message}</small> : null}
            <button type="submit" disabled={password.length < 8 || password !== passwordConfirmation}>{accessCopy.saveAndEnter}</button>
          </form> : state === 'password-reset' ? <form onSubmit={requestPasswordReset}>
            <p>{passwordResetSent ? message : accessCopy.passwordResetDescription}</p>
            <label>
              <span>{accessCopy.email}</span>
              <input autoComplete="email" type="email" value={accessToken} onChange={(event) => { setAccessToken(event.target.value); setPasswordResetSent(false); setMessage('') }} placeholder="name@company.com" />
            </label>
            {message && !passwordResetSent ? <small role="alert">{message}</small> : null}
            <button type="submit" disabled={passwordResetBusy || !accessToken.trim()}>{passwordResetBusy ? accessCopy.checkingTitle : accessCopy.sendResetLink}</button>
            <button className="product-access__alternate" type="button" onClick={() => { setState('sign-in'); setMessage(''); setPasswordResetSent(false) }}>{accessCopy.backToSignIn}</button>
          </form> : <form onSubmit={signIn}>
            <p>{useLegacyToken ? accessCopy.legacyDescription : supabaseAuthEnabled ? accessCopy.accountDescription : accessCopy.tokenDescription}</p>
            <label>
              <span>{useLegacyToken ? accessCopy.token : supabaseAuthEnabled ? accessCopy.email : accessCopy.token}</span>
              <input autoComplete={useLegacyToken || !supabaseAuthEnabled ? 'current-password' : 'email'} type={useLegacyToken || !supabaseAuthEnabled ? 'password' : 'email'} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={useLegacyToken || !supabaseAuthEnabled ? accessCopy.tokenPlaceholder : 'name@company.com'} />
            </label>
            {supabaseAuthEnabled && !useLegacyToken ? <label>
              <span>{accessCopy.password}</span>
              <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={accessCopy.passwordPlaceholder} />
            </label> : null}
            {message ? <small role="alert">{message}</small> : null}
            <button type="submit">{accessCopy.enterWorkspace}</button>
            {supabaseAuthEnabled && !useLegacyToken ? <button className="product-access__alternate" type="button" onClick={() => { setState('password-reset'); setMessage(''); setPasswordResetSent(false) }}>{accessCopy.forgotPassword}</button> : null}
            {hybridAuthEnabled ? <button className="product-access__alternate" type="button" onClick={() => {
              setAuthMethod(useLegacyToken ? 'account' : 'legacy')
              setAccessToken('')
              setPassword('')
              setMessage('')
            }}>{useLegacyToken ? accessCopy.backToEmail : accessCopy.useLegacyToken}</button> : null}
            {accessIsDialog ? <button className="product-access__alternate" type="button" onClick={returnToLanding}>{accessCopy.backToProduct}</button> : null}
          </form>
        )}
        {user ? <small>{user.name}</small> : null}
      </section>
    </main>
  )

  if (statusPage && state !== 'password-setup') {
    return (
      <ProductAppFrame>
        <Suspense fallback={<main className="product-status" aria-busy="true" />}>
          <StatusWorkspace
            isAuthenticated={Boolean(user)}
            onEnterWorkspace={enterWorkspace}
            ariaHidden={accessIsDialog}
          />
        </Suspense>
        {accessIsDialog ? accessOverlay : null}
        <Analytics />
      </ProductAppFrame>
    )
  }

  if (state === 'ready') return (
    <ProductAppFrame>
      <Suspense fallback={<main className="product-access" aria-live="polite"><section><span>BOTANIC</span><h1>{accessCopy.loadingWorkspace}</h1></section></main>}>
        <CanvasWorkspace
          currentUser={user ?? undefined}
          onSignOut={serverPersistenceEnabled ? signOut : undefined}
          onReturnToLanding={returnToLanding}
          productHomeLabel={locale === 'en' ? 'Product home' : '产品首页'}
          releaseLabel={releaseLabel}
        />
      </Suspense>
      <Analytics />
    </ProductAppFrame>
  )

  const landing = <ProductLanding
    isAuthenticated={Boolean(user)}
    onEnterWorkspace={enterWorkspace}
    ariaHidden={accessIsDialog}
  />

  if (state === 'landing') return <ProductAppFrame>{landing}<Analytics /></ProductAppFrame>

  return (
    <ProductAppFrame>
      {accessIsDialog ? landing : null}
      {accessOverlay}
      <Analytics />
    </ProductAppFrame>
  )
}

export default App
