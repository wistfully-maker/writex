export interface NovelConfig {
  schemaVersion: 1
  title: string
  language: 'zh-CN'
  style: string
  qualityProfile: string
}

export interface NovelSnapshot {
  root: string
  config: NovelConfig
}
