import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from '@/hooks/use-sidebar-workspaces-list'

export interface SidebarProjectRowModel {
  interaction: 'toggle' | 'navigate'
  chevron: 'expand' | 'collapse' | 'disclosure'
  trailingAction: 'new_worktree' | 'none'
  flattenedWorkspace: SidebarWorkspaceEntry | null
  selected: boolean
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry
  collapsed: boolean
  serverId?: string | null
  activeWorkspaceSelection?: { serverId: string; workspaceId: string } | null
}): SidebarProjectRowModel {
  const flattenedWorkspace =
    input.project.projectKind === 'non_git' && input.project.workspaces.length === 1
      ? input.project.workspaces[0] ?? null
      : null
  const selected =
    flattenedWorkspace !== null &&
    Boolean(input.serverId) &&
    input.activeWorkspaceSelection?.serverId === input.serverId &&
    input.activeWorkspaceSelection?.workspaceId === flattenedWorkspace.workspaceId

  if (flattenedWorkspace) {
    return {
      interaction: 'navigate',
      chevron: 'disclosure',
      trailingAction: 'none',
      flattenedWorkspace,
      selected,
    }
  }

  return {
    interaction: 'toggle',
    chevron: input.collapsed ? 'expand' : 'collapse',
    trailingAction: input.project.projectKind === 'git' ? 'new_worktree' : 'none',
    flattenedWorkspace: null,
    selected: false,
  }
}
