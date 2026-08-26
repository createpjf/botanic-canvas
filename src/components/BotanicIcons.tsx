type BotanicIconProps = { className?: string }

function opticalClass(kind: string, className?: string) {
  return className ? `optical-icon--${kind} ${className}` : `optical-icon--${kind}`
}

export function FigmaIcon({ src, alt = '' }: { src: string; alt?: string }) {
  return <img src={src} alt={alt} aria-hidden={alt === ''} />
}

/** Agent 面板 · 结果画廊 */
export function GalleryIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8" cy="9" r="1.25" stroke="currentColor" strokeWidth="1.5" />
    <path d="m4.5 17 4.25-4.25 3.25 3 2.25-2.25L19.5 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** Agent 面板 · 生成任务清单 */
export function ChecklistIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.5 5.5h11M8.5 12h11M8.5 18.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="m3.5 5.5 1.25 1.25L7 4.5M3.5 12l1.25 1.25L7 11M3.5 18.5l1.25 1.25L7 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** Agent 面板 · 项目记忆 */
export function BookmarkIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 4.25A1.75 1.75 0 0 1 7.75 2.5h8.5A1.75 1.75 0 0 1 18 4.25v17.1l-6-3.8-6 3.8V4.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
}

/** 通用编辑动作 */
export function EditIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m4 16.75-.75 3.5 3.5-.75L18.2 8.05a2.3 2.3 0 0 0-3.25-3.25L4 16.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="m13.75 6.25 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
}

/** 通用复制动作 */
export function CopyIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" />
  </svg>
}

/** 通用正向反馈 */
export function ThumbUpIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.5 10.5v9.25h-3A1.75 1.75 0 0 1 3.75 18v-5.75A1.75 1.75 0 0 1 5.5 10.5h3Zm0 0 4.35-6.8a1.4 1.4 0 0 1 2.58.93l-.55 3.37h4.37a1.75 1.75 0 0 1 1.72 2.05l-1.2 7.15a3 3 0 0 1-2.96 2.5H8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 通用负向反馈 */
export function ThumbDownIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.5 13.5V4.25h-3A1.75 1.75 0 0 0 3.75 6v5.75A1.75 1.75 0 0 0 5.5 13.5h3Zm0 0 4.35 6.8a1.4 1.4 0 0 0 2.58-.93l-.55-3.37h4.37a1.75 1.75 0 0 0 1.72-2.05l-1.2-7.15a3 3 0 0 0-2.96-2.5H8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 通用重试动作 */
export function RefreshIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M20 11a8 8 0 0 0-14.85-3.9L3 10m0 0V5.5M3 10h4.5M4 13a8 8 0 0 0 14.85 3.9L21 14m0 0v4.5M21 14h-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 通用完成状态 */
export function CheckIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('check', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m5 12.5 4.25 4.25L19 7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 通用等待状态 */
export function ClockIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12 7.25v5l3.25 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 通用警告状态 */
export function AlertIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3.25 21 19.75H3L12 3.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M12 9v4.25M12 16.25v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
}

/** Agent 时间线 · 搜索 */
export function SearchIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.25" stroke="currentColor" strokeWidth="1.5" />
    <path d="m15.25 15.25 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
}

/** Agent 时间线 · 技能指南 */
export function BookIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 4.5h5.25A2.75 2.75 0 0 1 12 7.25v12A2.75 2.75 0 0 0 9.25 16.5H4v-12Zm16 0h-5.25A2.75 2.75 0 0 0 12 7.25v12a2.75 2.75 0 0 1 2.75-2.75H20v-12Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
}

/** Agent 时间线 · 浏览器 Runtime */
export function GlobeIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3.5 12h17M12 3.25c2.25 2.4 3.25 5.32 3.25 8.75S14.25 18.35 12 20.75C9.75 18.35 8.75 15.43 8.75 12S9.75 5.65 12 3.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 参数调整动作 */
export function SlidersIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 6.25h16M4 12h16M4 17.75h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="6.25" r="1.75" fill="currentColor" />
    <circle cx="15" cy="12" r="1.75" fill="currentColor" />
    <circle cx="10" cy="17.75" r="1.75" fill="currentColor" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Close Square（1228:231093） */
export function CloseIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('close', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m14.398 9.595-4.792 4.792M14.394 14.39 9.598 9.593" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    <path d="M12 21.25A9.25 9.25 0 1 0 12 2.75a9.25 9.25 0 0 0 0 18.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
}

/** 植物学 Figma · Ikonate/ellypsis（1228:230194） */
export function MoreIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="6" cy="12" r="1" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="12" cy="12" r="1" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="18" cy="12" r="1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
}

/** 画布导航地图 */
export function MapIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m3.25 5.5 5.5-2.25 6.5 2.5 5.5-2.25v15l-5.5 2.25-6.5-2.5-5.5 2.25v-15Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M8.75 3.25v15m6.5-12.5v15" stroke="currentColor" strokeWidth="1.5" />
  </svg>
}

/** 适配当前画布上下文 */
export function FocusIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8 3.25H5.25a2 2 0 0 0-2 2V8m12.75-4.75h2.75a2 2 0 0 1 2 2V8M8 20.75H5.25a2 2 0 0 1-2-2V16m12.75 4.75h2.75a2 2 0 0 0 2-2V16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="12" cy="12" r="2.25" stroke="currentColor" strokeWidth="1.5" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Delete（1228:230946） */
export function DeleteIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.625 7.403h14.748L18.046 21.25H5.951L4.625 7.403ZM7.813 2.75h8.376M12 12v4.653" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Upload（1228:231146） */
export function UploadIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3.231v12.778M8.727 5.771 12.002 2.48l3.276 3.291M16.625 10.995H21.25v10.524H2.75V10.995h4.625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Download（1228:231097） */
export function DownloadIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 15.935V3.157M8.727 13.395l3.275 3.29 3.276-3.29M16.625 9.414H21.25v11.429H2.75V9.414h4.625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Home（1228:230877） */
export function HomeIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M1.934 11.376 12 2.75l10.066 8.626M4.094 10.159V21.25h15.817V10.16M12 12.705v3.408" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Star（1228:231230） */
export function SparkleIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('sparkle', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2.75C13.17 7.287 16.713 10.83 21.25 12c-4.537 1.17-8.08 4.713-9.25 9.25C10.83 16.713 7.287 13.17 2.75 12 7.287 10.83 10.83 7.287 12 2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M18.752 2.75c0 1.148 1.32 2.498 2.499 2.498-1.225 0-2.499 1.337-2.499 2.499 0-1.17-1.353-2.5-2.498-2.5 1.19 0 2.498-1.35 2.498-2.497Z" fill="currentColor" />
  </svg>
}

/** Botanic Agent 形象 · Bob（四角星 + 右上微光） */
export function BobIcon({ className }: BotanicIconProps) {
  return <SparkleIcon className={className} />
}

/** 植物学 Figma · Iconly/Sharp/Folder（1228:230858） */
export function FolderOutlineIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7.633 15.087h8.735M21.25 20.327H2.75V3.673h6.963l2.262 2.779h9.275v13.875Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

/** 植物学 Figma · Iconly/Sharp/Plus（1228:231211） */
export function PlusSquareIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 8.328v7.326m3.665-3.663H8.332M21.25 21.25V2.75H2.75v18.5h18.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="round" />
  </svg>
}

/** Agent composer · plain plus action */
export function PlusIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('plus', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 4.5v15M4.5 12h15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
}

/** Agent 执行模式 · 自动执行 */
export function AutoRunIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('play', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="1.5" />
    <path d="m10 8.75 5 3.25-5 3.25V8.75Z" fill="currentColor" />
  </svg>
}

/** 植物学 Figma · arrow-right-top（1228:230741） */
export function ArrowUpRightIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('ne', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m7.25 16.75 9.5-9.5M9.25 7.25h7.5v7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="round" />
  </svg>
}

/** 植物学 Figma · arrow-up / arrow-down（1228:230754 / 1228:230698） */
/** Composer · 停止当前回合 */
export function StopIcon({ className }: BotanicIconProps) {
  return <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
}

export function ArrowUpIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('up', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21.25V3.5m0 0L6.75 8.75M12 3.5l5.25 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="round" /></svg>
}

export function ArrowDownIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('down', className)} width="1em" height="1em" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.75V20.5m0 0 5.25-5.25M12 20.5l-5.25-5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="round" /></svg>
}

/** 工具面板 · 返回对话 */
export function ChevronLeftIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('left', className)} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10 3.5 5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** 下拉触发器 · 与文字同行垂直居中 */
export function ChevronDownIcon({ className }: BotanicIconProps) {
  return <svg className={opticalClass('down', className)} width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
