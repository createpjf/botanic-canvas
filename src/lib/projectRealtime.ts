import { parseProjectRealtimeEvent, projectRealtimeConnectionOpened, type ProjectRealtimeConnectionState, type ProjectRealtimeEvent } from '../domain/realtimeSync'
import { productRequest, serverPersistenceEnabled } from './productSession'

type RealtimeTicket = {
  ticket: string
  expiresIn: number
  websocketUrl: string
}

function websocketUrl(endpoint: string, projectId: string, ticket: string) {
  const url = new URL(endpoint, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('projectId', projectId)
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

export type ProjectRealtimeChannel = {
  publish: (event: ProjectRealtimeEvent) => boolean
  close: () => void
}

export type ProjectRealtimeConnectionOpened = {
  reconnected: boolean
}

export function openProjectRealtimeChannel(
  projectId: string,
  onEvent: (event: ProjectRealtimeEvent) => void,
  onConnectionOpened?: (event: ProjectRealtimeConnectionOpened) => void,
  onConnectionStateChanged?: (state: ProjectRealtimeConnectionState) => void,
): ProjectRealtimeChannel {
  if (!serverPersistenceEnabled || !projectId) {
    return { publish: () => false, close: () => undefined }
  }

  let closed = false
  let socket: WebSocket | undefined
  let reconnectTimer: number | undefined
  let connectionRun = 0
  let retryCount = 0
  let openedBefore = false
  let connectionState: ProjectRealtimeConnectionState = 'closed'

  const notifyConnectionState = (state: ProjectRealtimeConnectionState) => {
    if (closed && state !== 'closed') return
    if (connectionState === state) return
    connectionState = state
    onConnectionStateChanged?.(state)
  }

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return
    notifyConnectionState(openedBefore ? 'reconnecting' : 'connecting')
    const delay = Math.min(15_000, 1_000 * (2 ** Math.min(retryCount, 4)))
    retryCount += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (closed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
    const run = ++connectionRun
    try {
      const { ticket, websocketUrl: endpoint } = await productRequest<RealtimeTicket>('/api/realtime/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      if (closed || run !== connectionRun) return
      const nextSocket = new WebSocket(websocketUrl(endpoint, projectId, ticket))
      socket = nextSocket
      nextSocket.addEventListener('open', () => {
        if (closed || run !== connectionRun) return
        retryCount = 0
        const connection = projectRealtimeConnectionOpened(openedBefore)
        openedBefore = connection.openedBefore
        notifyConnectionState('connected')
        onConnectionOpened?.(connection.event)
        nextSocket.send(JSON.stringify({ type: 'collaboration.presence.subscribe', projectId }))
      })
      nextSocket.addEventListener('message', (message) => {
        try {
          const event = parseProjectRealtimeEvent(JSON.parse(String(message.data)), projectId)
          if (event) onEvent(event)
        } catch {
          // 忽略未知或损坏的推送；权威文档仍会在聚焦与重连时重新读取。
        }
      })
      nextSocket.addEventListener('close', () => {
        if (run !== connectionRun) return
        socket = undefined
        scheduleReconnect()
      })
      nextSocket.addEventListener('error', () => nextSocket.close())
    } catch {
      scheduleReconnect()
    }
  }

  const reconnectWhenOnline = () => {
    retryCount = 0
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    notifyConnectionState(openedBefore ? 'reconnecting' : 'connecting')
    void connect()
  }
  window.addEventListener('online', reconnectWhenOnline)
  notifyConnectionState('connecting')
  void connect()

  return {
    publish(event) {
      if (closed || socket?.readyState !== WebSocket.OPEN || event.projectId !== projectId) return false
      socket.send(JSON.stringify(event))
      return true
    },
    close() {
      if (closed) return
      closed = true
      connectionRun += 1
      notifyConnectionState('closed')
      window.removeEventListener('online', reconnectWhenOnline)
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close(1000, 'project changed')
    },
  }
}

export function subscribeProjectRealtime(
  projectId: string,
  onEvent: (event: ProjectRealtimeEvent) => void,
) {
  const channel = openProjectRealtimeChannel(projectId, onEvent)
  return () => channel.close()
}
