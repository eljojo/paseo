import { useCallback, useMemo, useRef, useState } from 'react'
import { View, Text, Platform, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Brain, ChevronDown, SlidersHorizontal } from 'lucide-react-native'
import { useQuery } from '@tanstack/react-query'
import { useSessionStore } from '@/stores/session-store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { AdaptiveModalSheet } from '@/components/adaptive-modal-sheet'
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from '@server/server/agent/agent-sdk-types'
import type { AgentProviderDefinition } from '@server/server/agent/provider-manifest'
import { normalizeModelId, resolveAgentModelSelection } from '@/components/agent-status-bar.utils'

type StatusOption = {
  id: string
  label: string
}

type ControlledAgentStatusBarProps = {
  providerOptions?: StatusOption[]
  selectedProviderId?: string
  onSelectProvider?: (providerId: string) => void
  modeOptions?: StatusOption[]
  selectedModeId?: string
  onSelectMode?: (modeId: string) => void
  modelOptions?: StatusOption[]
  selectedModelId?: string
  onSelectModel?: (modelId: string) => void
  thinkingOptions?: StatusOption[]
  selectedThinkingOptionId?: string
  onSelectThinkingOption?: (thinkingOptionId: string) => void
  disabled?: boolean
  isModelLoading?: boolean
}

export interface DraftAgentStatusBarProps {
  providerDefinitions: AgentProviderDefinition[]
  selectedProvider: AgentProvider
  onSelectProvider: (provider: AgentProvider) => void
  modeOptions: AgentMode[]
  selectedMode: string
  onSelectMode: (modeId: string) => void
  models: AgentModelDefinition[]
  selectedModel: string
  onSelectModel: (modelId: string) => void
  isModelLoading: boolean
  thinkingOptions: NonNullable<AgentModelDefinition['thinkingOptions']>
  selectedThinkingOptionId: string
  onSelectThinkingOption: (thinkingOptionId: string) => void
  disabled?: boolean
}

interface AgentStatusBarProps {
  agentId: string
  serverId: string
}

function findOptionLabel(options: StatusOption[] | undefined, selectedId: string | undefined, fallback: string) {
  if (!options || options.length === 0) {
    return fallback
  }
  const selected = options.find((option) => option.id === selectedId)
  return selected?.label ?? fallback
}

function ControlledStatusBar({
  providerOptions,
  selectedProviderId,
  onSelectProvider,
  modeOptions,
  selectedModeId,
  onSelectMode,
  modelOptions,
  selectedModelId,
  onSelectModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
}: ControlledAgentStatusBarProps) {
  const { theme } = useUnistyles()
  const isWeb = Platform.OS === 'web'
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [openSelector, setOpenSelector] = useState<'provider' | 'mode' | 'model' | 'thinking' | null>(null)

  const providerAnchorRef = useRef<View>(null)
  const modeAnchorRef = useRef<View>(null)
  const modelAnchorRef = useRef<View>(null)
  const thinkingAnchorRef = useRef<View>(null)

  const canSelectProvider = Boolean(onSelectProvider && providerOptions && providerOptions.length > 0)
  const canSelectMode = Boolean(onSelectMode && modeOptions && modeOptions.length > 0)
  const canSelectModel = Boolean(onSelectModel)
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 0
  )

  const displayProvider = findOptionLabel(providerOptions, selectedProviderId, 'Provider')
  const displayMode = findOptionLabel(modeOptions, selectedModeId, 'Default')
  const displayModel =
    isModelLoading && (!modelOptions || modelOptions.length === 0)
      ? 'Loading models...'
      : findOptionLabel(modelOptions, selectedModelId, 'Auto')
  const displayThinking = findOptionLabel(thinkingOptions, selectedThinkingOptionId, 'auto')

  const hasAnyControl =
    Boolean(providerOptions?.length) ||
    Boolean(modeOptions?.length) ||
    canSelectModel ||
    Boolean(thinkingOptions?.length)

  if (!hasAnyControl) {
    return null
  }

  const modelDisabled = disabled || isModelLoading || !modelOptions || modelOptions.length === 0

  const SEARCH_THRESHOLD = 6

  const comboboxProviderOptions = useMemo<ComboboxOption[]>(
    () => (providerOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [providerOptions]
  )
  const comboboxModeOptions = useMemo<ComboboxOption[]>(
    () => (modeOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [modeOptions]
  )
  const comboboxModelOptions = useMemo<ComboboxOption[]>(
    () => (modelOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [modelOptions]
  )
  const comboboxThinkingOptions = useMemo<ComboboxOption[]>(
    () => (thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [thinkingOptions]
  )

  const handleOpenChange = useCallback(
    (selector: 'provider' | 'mode' | 'model' | 'thinking') => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null)
    },
    []
  )

  return (
    <View style={[styles.container, isWeb && { marginBottom: -theme.spacing[1] }]}>
      {isWeb ? (
        <>
          {providerOptions && providerOptions.length > 0 ? (
            <>
              <Pressable
                ref={providerAnchorRef}
                collapsable={false}
                disabled={disabled || !canSelectProvider}
                onPress={() => setOpenSelector(openSelector === 'provider' ? null : 'provider')}
                style={({ pressed, hovered }) => [
                  styles.modeBadge,
                  hovered && styles.modeBadgeHovered,
                  (pressed || openSelector === 'provider') && styles.modeBadgePressed,
                  (disabled || !canSelectProvider) && styles.disabledBadge,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select agent provider"
                testID="agent-provider-selector"
              >
                <Text style={styles.modeBadgeText}>{displayProvider}</Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Combobox
                options={comboboxProviderOptions}
                value={selectedProviderId ?? ''}
                onSelect={(id) => onSelectProvider?.(id)}
                searchable={comboboxProviderOptions.length > SEARCH_THRESHOLD}
                open={openSelector === 'provider'}
                onOpenChange={handleOpenChange('provider')}
                anchorRef={providerAnchorRef}
                desktopPlacement="top-start"
              />
            </>
          ) : null}

          {modeOptions && modeOptions.length > 0 ? (
            <>
              <Pressable
                ref={modeAnchorRef}
                collapsable={false}
                disabled={disabled || !canSelectMode}
                onPress={() => setOpenSelector(openSelector === 'mode' ? null : 'mode')}
                style={({ pressed, hovered }) => [
                  styles.modeBadge,
                  hovered && styles.modeBadgeHovered,
                  (pressed || openSelector === 'mode') && styles.modeBadgePressed,
                  (disabled || !canSelectMode) && styles.disabledBadge,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select agent mode"
                testID="agent-mode-selector"
              >
                <Text style={styles.modeBadgeText}>{displayMode}</Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Combobox
                options={comboboxModeOptions}
                value={selectedModeId ?? ''}
                onSelect={(id) => onSelectMode?.(id)}
                searchable={comboboxModeOptions.length > SEARCH_THRESHOLD}
                open={openSelector === 'mode'}
                onOpenChange={handleOpenChange('mode')}
                anchorRef={modeAnchorRef}
                desktopPlacement="top-start"
              />
            </>
          ) : null}

          <Pressable
            ref={modelAnchorRef}
            collapsable={false}
            disabled={modelDisabled}
            onPress={() => setOpenSelector(openSelector === 'model' ? null : 'model')}
            style={({ pressed, hovered }) => [
              styles.modeBadge,
              hovered && styles.modeBadgeHovered,
              (pressed || openSelector === 'model') && styles.modeBadgePressed,
              modelDisabled && styles.disabledBadge,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Select agent model"
            testID="agent-model-selector"
          >
            <Text style={styles.modeBadgeText}>{displayModel}</Text>
            <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Combobox
            options={comboboxModelOptions}
            value={selectedModelId ?? ''}
            onSelect={(id) => onSelectModel?.(id)}
            searchable={comboboxModelOptions.length > SEARCH_THRESHOLD}
            open={openSelector === 'model'}
            onOpenChange={handleOpenChange('model')}
            anchorRef={modelAnchorRef}
            desktopPlacement="top-start"
          />

          {thinkingOptions && thinkingOptions.length > 0 ? (
            <>
              <Pressable
                ref={thinkingAnchorRef}
                collapsable={false}
                disabled={disabled || !canSelectThinking}
                onPress={() => setOpenSelector(openSelector === 'thinking' ? null : 'thinking')}
                style={({ pressed, hovered }) => [
                  styles.modeBadge,
                  hovered && styles.modeBadgeHovered,
                  (pressed || openSelector === 'thinking') && styles.modeBadgePressed,
                  (disabled || !canSelectThinking) && styles.disabledBadge,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select thinking option"
                testID="agent-thinking-selector"
              >
                <Brain
                  size={theme.iconSize.xs}
                  color={theme.colors.foregroundMuted}
                  style={{ marginTop: 1 }}
                />
                <Text style={styles.modeBadgeText}>{displayThinking}</Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Combobox
                options={comboboxThinkingOptions}
                value={selectedThinkingOptionId ?? ''}
                onSelect={(id) => onSelectThinkingOption?.(id)}
                searchable={comboboxThinkingOptions.length > SEARCH_THRESHOLD}
                open={openSelector === 'thinking'}
                onOpenChange={handleOpenChange('thinking')}
                anchorRef={thinkingAnchorRef}
                desktopPlacement="top-start"
              />
            </>
          ) : null}
        </>
      ) : (
        <>
          <Pressable
            onPress={() => setPrefsOpen(true)}
            style={({ pressed }) => [
              styles.prefsButton,
              pressed && styles.prefsButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Agent preferences"
            testID="agent-preferences-button"
          >
            <SlidersHorizontal size={theme.iconSize.lg} color={theme.colors.foreground} />
          </Pressable>

          <AdaptiveModalSheet
            title="Preferences"
            visible={prefsOpen}
            onClose={() => setPrefsOpen(false)}
            testID="agent-preferences-sheet"
          >
            {providerOptions && providerOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectProvider}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectProvider) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select agent provider"
                    testID="agent-preferences-provider"
                  >
                    <Text style={styles.sheetSelectText}>{displayProvider}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {providerOptions.map((provider) => (
                      <DropdownMenuItem
                        key={provider.id}
                        selected={provider.id === selectedProviderId}
                        onSelect={() => onSelectProvider?.(provider.id)}
                      >
                        {provider.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}

            {modeOptions && modeOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectMode}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectMode) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select agent mode"
                    testID="agent-preferences-mode"
                  >
                    <Text style={styles.sheetSelectText}>{displayMode}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {modeOptions.map((mode) => (
                      <DropdownMenuItem
                        key={mode.id}
                        selected={mode.id === selectedModeId}
                        onSelect={() => onSelectMode?.(mode.id)}
                      >
                        {mode.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}

            <View style={styles.sheetSection}>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={modelDisabled}
                  style={({ pressed }) => [
                    styles.sheetSelect,
                    pressed && styles.sheetSelectPressed,
                    modelDisabled && styles.disabledSheetSelect,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Select agent model"
                  testID="agent-preferences-model"
                >
                  <Text style={styles.sheetSelectText}>{displayModel}</Text>
                  <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start">
                  {(modelOptions ?? []).map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      selected={model.id === selectedModelId}
                      onSelect={() => onSelectModel?.(model.id)}
                    >
                      {model.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </View>

            {thinkingOptions && thinkingOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectThinking}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectThinking) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select thinking option"
                    testID="agent-preferences-thinking"
                  >
                    <Text style={styles.sheetSelectText}>{displayThinking}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {thinkingOptions.map((thinking) => (
                      <DropdownMenuItem
                        key={thinking.id}
                        selected={thinking.id === selectedThinkingOptionId}
                        onSelect={() => onSelectThinkingOption?.(thinking.id)}
                      >
                        {thinking.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}
          </AdaptiveModalSheet>
        </>
      )}
    </View>
  )
}

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents?.get(agentId))
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null)

  const modelsQuery = useQuery({
    queryKey: [
      'providerModels',
      serverId,
      agent?.provider ?? '__missing_provider__',
      agent?.cwd ?? '__missing_cwd__',
    ],
    enabled: Boolean(client && agent?.provider),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !agent) {
        throw new Error('Daemon client unavailable')
      }
      const payload = await client.listProviderModels(agent.provider, { cwd: agent.cwd })
      if (payload.error) {
        throw new Error(payload.error)
      }
      return payload.models ?? []
    },
  })

  const models = modelsQuery.data ?? null

  const displayMode =
    agent?.availableModes?.find((mode) => mode.id === agent.currentModeId)?.label ||
    agent?.currentModeId ||
    'default'

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeInfo?.model,
    configuredModelId: agent?.model,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  })

  const modeOptions = useMemo<StatusOption[]>(() => {
    return (agent?.availableModes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.label,
    }))
  }, [agent?.availableModes])

  const modelOptions = useMemo<StatusOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }))
  }, [models])

  const thinkingOptions = useMemo<StatusOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    }))
  }, [modelSelection.thinkingOptions])

  if (!agent) {
    return null
  }

  return (
    <ControlledStatusBar
      modeOptions={
        modeOptions.length > 0
          ? modeOptions
          : [{ id: agent.currentModeId ?? '', label: displayMode }]
      }
      selectedModeId={agent.currentModeId ?? undefined}
      onSelectMode={(modeId) => {
        if (!client) {
          return
        }
        void client.setAgentMode(agentId, modeId).catch((error) => {
          console.warn('[AgentStatusBar] setAgentMode failed', error)
        })
      }}
      modelOptions={modelOptions}
      selectedModelId={modelSelection.activeModelId ?? undefined}
      onSelectModel={(modelId) => {
        if (!client) {
          return
        }
        void client.setAgentModel(agentId, modelId).catch((error) => {
          console.warn('[AgentStatusBar] setAgentModel failed', error)
        })
      }}
      thinkingOptions={thinkingOptions.length > 1 ? thinkingOptions : undefined}
      selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
      onSelectThinkingOption={(thinkingOptionId) => {
        if (!client) {
          return
        }
        void client.setAgentThinkingOption(agentId, thinkingOptionId).catch((error) => {
          console.warn('[AgentStatusBar] setAgentThinkingOption failed', error)
        })
      }}
      isModelLoading={modelsQuery.isPending || modelsQuery.isFetching}
      disabled={!client}
    />
  )
}

export function DraftAgentStatusBar({
  providerDefinitions,
  selectedProvider,
  onSelectProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  isModelLoading,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
}: DraftAgentStatusBarProps) {
  const providerOptions = useMemo<StatusOption[]>(() => {
    return providerDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
    }))
  }, [providerDefinitions])

  const mappedModeOptions = useMemo<StatusOption[]>(() => {
    if (modeOptions.length === 0) {
      return [{ id: '', label: 'Default' }]
    }
    return modeOptions.map((mode) => ({ id: mode.id, label: mode.label }))
  }, [modeOptions])

  const modelOptions = useMemo<StatusOption[]>(() => {
    const options: StatusOption[] = [{ id: '', label: 'Auto' }]
    for (const model of models) {
      options.push({ id: model.id, label: model.label })
    }
    return options
  }, [models])

  const mappedThinkingOptions = useMemo<StatusOption[]>(() => {
    return thinkingOptions.map((option) => ({ id: option.id, label: option.label }))
  }, [thinkingOptions])

  const effectiveSelectedMode = selectedMode || mappedModeOptions[0]?.id || ''
  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined

  return (
    <ControlledStatusBar
      providerOptions={providerOptions}
      selectedProviderId={selectedProvider}
      onSelectProvider={(providerId) => onSelectProvider(providerId as AgentProvider)}
      modeOptions={mappedModeOptions}
      selectedModeId={effectiveSelectedMode}
      onSelectMode={onSelectMode}
      modelOptions={modelOptions}
      selectedModelId={selectedModel}
      onSelectModel={onSelectModel}
      isModelLoading={isModelLoading}
      thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
      selectedThinkingOptionId={effectiveSelectedThinkingOption}
      onSelectThinkingOption={onSelectThinkingOption}
      disabled={disabled}
    />
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
  },
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius['2xl'],
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabledBadge: {
    opacity: 0.5,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  prefsButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  prefsButtonPressed: {
    backgroundColor: theme.colors.surface0,
  },
  sheetSection: {
    gap: theme.spacing[2],
  },
  sheetSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  sheetSelectPressed: {
    backgroundColor: theme.colors.surface2,
  },
  disabledSheetSelect: {
    opacity: 0.5,
  },
  sheetSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
}))
