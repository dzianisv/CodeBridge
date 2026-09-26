// Shapes taken from Jira Cloud platform REST OpenAPI
// https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
// (fetched 2026-09-25, info.version 1001.0.0-SNAPSHOT).
// SearchAndReconcileResults / Comment / PageOfComments / UserDetails.
// IssueBean.fields is an untyped object in that spec. The field names below are the
// standard issue fields requested by the poller. Not confirmed against a live site.

export type JiraUser = {
  accountId?: string
  displayName?: string
}

export type JiraComment = {
  id?: string
  created?: string
  updated?: string
  author?: JiraUser | null
  body?: unknown
}

export type JiraPageOfComments = {
  comments?: JiraComment[]
  startAt?: number
  maxResults?: number
  total?: number
}

export type JiraIssueFields = {
  summary?: string
  updated?: string
  assignee?: JiraUser | null
  status?: { id?: string; name?: string } | null
  comment?: JiraPageOfComments | null
}

export type JiraIssue = {
  id: string
  key: string
  fields?: JiraIssueFields
}

export type JiraSearchAndReconcileResults = {
  issues?: JiraIssue[]
  nextPageToken?: string | null
  isLast?: boolean
}

export type AdfMark = { type: string }

export type AdfNode = {
  type: string
  version?: number
  text?: string
  content?: AdfNode[]
  marks?: AdfMark[]
}

// Minimal ADF pair for plain-text comments. Not a full ADF implementation.
// Doc shape: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
export function textToAdf(text: string): AdfNode {
  const lines = text.split("\n")
  return {
    type: "doc",
    version: 1,
    content: lines.map(line => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : []
    }))
  }
}

export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const current = node as AdfNode
  if (current.type === "text" && typeof current.text === "string") return current.text
  if (current.type === "hardBreak") return "\n"
  const children = Array.isArray(current.content) ? current.content : []
  if (children.length === 0) return ""
  const parts = children.map(child => adfToText(child))
  if (current.type === "doc" || current.type === "bulletList" || current.type === "orderedList") {
    return parts.filter(part => part.length > 0).join("\n")
  }
  return parts.join("")
}
