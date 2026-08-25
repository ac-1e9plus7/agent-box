import type { MessageAttachment, MessageAttachmentType } from '../../shared/types'
import { t } from '../../shared/i18n'

const MAX_IMAGE_DIMENSION = 2048
const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB

const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'php',
  'rb',
  'sh',
  'bash',
  'zsh',
  'bat',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'toml',
  'ini',
  'env',
  'dockerfile',
  'makefile',
  'r',
  'swift',
  'kt',
  'kts',
  'scala',
  'vue',
  'svelte',
  'tex',
  'log',
])

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : ''
}

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/xml' || file.type === 'application/javascript')
    return true
  const ext = getFileExtension(file.name)
  return TEXT_FILE_EXTENSIONS.has(ext)
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || getFileExtension(file.name) === 'pdf'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(t('Failed to read file {value0}', { value0: file.name })))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(t('Reading text file {value0} failed', { value0: file.name })))
    reader.readAsText(file, 'utf-8')
  })
}

async function resizeImageIfNeeded(dataUrl: string, mimeType: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
        resolve(dataUrl)
        return
      }

      if (width > height) {
        height = Math.round((height * MAX_IMAGE_DIMENSION) / width)
        width = MAX_IMAGE_DIMENSION
      } else {
        width = Math.round((width * MAX_IMAGE_DIMENSION) / height)
        height = MAX_IMAGE_DIMENSION
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      const exportType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
      resolve(canvas.toDataURL(exportType, 0.9))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

export async function processFile(file: File): Promise<MessageAttachment> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      t('File "{value0}" exceeds the size limit ({value1}).', {
        value0: file.name,
        value1: formatFileSize(MAX_FILE_SIZE),
      }),
    )
  }

  let type: MessageAttachmentType
  let data: string

  if (isImageFile(file)) {
    type = 'image'
    const rawDataUrl = await readFileAsDataUrl(file)
    data = await resizeImageIfNeeded(rawDataUrl, file.type)
  } else if (isPdfFile(file)) {
    type = 'document'
    data = await readFileAsDataUrl(file)
  } else if (isTextFile(file)) {
    type = 'text'
    data = await readFileAsText(file)
  } else {
    // Attempt reading as text for generic/code files, or fallback to data URL
    try {
      data = await readFileAsText(file)
      type = 'text'
    } catch {
      data = await readFileAsDataUrl(file)
      type = 'document'
    }
  }

  return {
    id: generateAttachmentId(),
    name: file.name,
    mimeType: file.type || (type === 'text' ? 'text/plain' : 'application/octet-stream'),
    size: file.size,
    data,
    type,
  }
}

export async function processSelectedFiles(files: FileList | File[]): Promise<MessageAttachment[]> {
  const fileArray = Array.from(files)
  const results: MessageAttachment[] = []
  for (const file of fileArray) {
    const attachment = await processFile(file)
    results.push(attachment)
  }
  return results
}
