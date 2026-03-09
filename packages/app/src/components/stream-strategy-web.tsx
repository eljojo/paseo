import {
  Fragment,
  type CSSProperties,
  createElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { measureElement as measureVirtualElement, useVirtualizer } from '@tanstack/react-virtual'
import { View } from 'react-native'
import {
  estimateStreamItemHeight,
  getWebMountedRecentStreamItems,
  getWebPartialVirtualizationThreshold,
  splitWebVirtualizedHistory,
} from './agent-stream-web-virtualization'
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from './stream-strategy'
import { createStreamStrategy } from './stream-strategy'

type CreateWebStreamStrategyInput = {
  isMobileBreakpoint: boolean
}

type ScrollBehaviorLike = 'auto' | 'smooth'

const WEB_BOTTOM_SETTLE_TIMEOUT_MS = 200
const USER_SCROLL_DELTA_EPSILON = 1
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1
const WEB_STREAM_SCROLLBAR_STYLE_ID = 'web-stream-viewport-scrollbar-style'
const WEB_STREAM_SCROLLBAR_STYLE = `
  #agent-chat-scroll-web-dom-scroll,
  #agent-chat-scroll-web-dom-virtualized {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  #agent-chat-scroll-web-dom-scroll::-webkit-scrollbar,
  #agent-chat-scroll-web-dom-virtualized::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }
`

function isScrollContainerNearBottom(
  scrollContainer: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  const { scrollTop, clientHeight, scrollHeight } = scrollContainer
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true
  }
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop
  return distanceFromBottom <= threshold
}

function isScrollContainerAtBottom(
  scrollContainer: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
): boolean {
  return isScrollContainerNearBottom(scrollContainer, AUTO_SCROLL_RESUME_THRESHOLD_PX)
}

function renderEdge(
  content: StreamRenderInput['edgeSlotProps']['ListHeaderComponent'],
  style?: CSSProperties
) {
  if (!content) {
    return null
  }
  const rendered = isValidElement(content) ? content : createElement(content)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        ...style,
      }}
    >
      {rendered}
    </div>
  )
}

function scrollElementToBottom(
  scrollContainer: HTMLElement,
  behavior: ScrollBehaviorLike = 'auto'
): void {
  scrollContainer.scrollTo({
    top: scrollContainer.scrollHeight,
    behavior,
  })
}

function syncNearBottom(
  scrollContainer: HTMLElement | null,
  onNearBottomChange: (value: boolean) => void
): boolean {
  if (!scrollContainer) {
    onNearBottomChange(true)
    return true
  }
  const nextValue = isScrollContainerNearBottom(scrollContainer)
  onNearBottomChange(nextValue)
  return nextValue
}

function getScrollContainerDistanceFromBottom(
  scrollContainer: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
): number {
  return scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop
}

function isScrollContainerOverscrolledPastBottom(
  scrollContainer: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
): boolean {
  return getScrollContainerDistanceFromBottom(scrollContainer) < 0
}

function WebStreamViewport(props: StreamRenderInput & { isMobileBreakpoint: boolean }) {
  const {
    rows,
    renderRow,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    forwardListContentContainerStyle,
    edgeSlotProps,
    isMobileBreakpoint,
  } = props
  const { WebDesktopScrollbarOverlay, useWebDesktopScrollbarMetrics } =
    require('./web-desktop-scrollbar') as typeof import('./web-desktop-scrollbar')
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const [followOutput, setFollowOutputr] = useState(true)
  const setFollowOutput = (value: boolean) => {
    console.trace('setFollowOutput', value)
    setFollowOutputr(value)
    return value
  }
  const followOutputRef = useRef(followOutput)
  const lastKnownScrollTopRef = useRef(0)
  const pendingUserScrollUpIntentRef = useRef(false)
  const isPointerScrollActiveRef = useRef(false)
  const lastTouchClientYRef = useRef<number | null>(null)
  const pendingAutoScrollFrameRef = useRef<number | null>(null)
  const pendingAutoScrollTimeoutRef = useRef<number | null>(null)
  const streamScrollbarMetrics = useWebDesktopScrollbarMetrics()
  const showDesktopWebScrollbar = !isMobileBreakpoint
  const shouldUseVirtualizer =
    !isMobileBreakpoint && rows.length > getWebPartialVirtualizationThreshold()

  followOutputRef.current = followOutput

  const indexedRows = useMemo(() => rows.map((item, index) => ({ item, index })), [rows])
  const webVirtualizedHistoryWindow = useMemo(() => {
    if (!shouldUseVirtualizer) {
      return null
    }
    return splitWebVirtualizedHistory({
      entries: indexedRows,
      minMountedCount: getWebMountedRecentStreamItems(),
    })
  }, [indexedRows, shouldUseVirtualizer])
  const virtualizedEntries = webVirtualizedHistoryWindow?.virtualizedEntries ?? []
  const mountedEntries = webVirtualizedHistoryWindow?.mountedEntries ?? indexedRows
  const activationKey = routeBottomAnchorRequest?.requestKey ?? props.agentId
  const isActivationReady = routeBottomAnchorRequest === null || isAuthoritativeHistoryReady

  const rowVirtualizer = useVirtualizer({
    count: virtualizedEntries.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => virtualizedEntries[index]?.item.id ?? index,
    estimateSize: (index: number) => {
      const row = virtualizedEntries[index]?.item
      return row ? estimateStreamItemHeight(row) : 120
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  })
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0
      const scrollOffset = instance.scrollOffset ?? 0
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight)
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX
    }
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])
  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualTotalSize = rowVirtualizer.getTotalSize()

  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current
    if (pendingFrame !== null) {
      pendingAutoScrollFrameRef.current = null
      window.cancelAnimationFrame(pendingFrame)
    }
    const pendingTimeout = pendingAutoScrollTimeoutRef.current
    if (pendingTimeout !== null) {
      pendingAutoScrollTimeoutRef.current = null
      window.clearTimeout(pendingTimeout)
    }
  }, [])

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehaviorLike = 'auto', source = 'unknown') => {
      const scrollContainer = scrollContainerRef.current
      if (!scrollContainer) {
        return
      }
      if (isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return
      }
      scrollElementToBottom(scrollContainer, behavior)
      lastKnownScrollTopRef.current = scrollContainer.scrollTop
      syncNearBottom(scrollContainer, onNearBottomChange)
    },
    [onNearBottomChange]
  )

  const scheduleStickToBottom = useCallback(
    (source = 'unknown') => {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer && isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return
      }
      if (pendingAutoScrollFrameRef.current !== null) {
        return
      }
      pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
        pendingAutoScrollFrameRef.current = null
        if (!followOutputRef.current) {
          return
        }
        scrollMessagesToBottom('auto', source)
      })
    },
    [scrollMessagesToBottom]
  )
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom()
    scrollMessagesToBottom('auto', 'force')
    scheduleStickToBottom('force')
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom])

  const updateScrollMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      onNearBottomChange(true)
      return
    }
    streamScrollbarMetrics.onContentSizeChange(
      scrollContainer.clientWidth,
      scrollContainer.scrollHeight
    )
    streamScrollbarMetrics.onLayout({
      nativeEvent: {
        layout: {
          width: scrollContainer.clientWidth,
          height: scrollContainer.clientHeight,
          x: 0,
          y: 0,
        },
      },
    } as never)
    streamScrollbarMetrics.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y: scrollContainer.scrollTop },
        contentSize: {
          width: scrollContainer.clientWidth,
          height: scrollContainer.scrollHeight,
        },
        layoutMeasurement: {
          width: scrollContainer.clientWidth,
          height: scrollContainer.clientHeight,
        },
      },
    } as never)
    syncNearBottom(scrollContainer, onNearBottomChange)
  }, [onNearBottomChange, streamScrollbarMetrics])

  const handleDomScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const currentScrollTop = scrollContainer.scrollTop
    const isNearBottom = syncNearBottom(scrollContainer, onNearBottomChange)
    const isAtBottom = isScrollContainerAtBottom(scrollContainer)
    const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - USER_SCROLL_DELTA_EPSILON

    if (!followOutputRef.current && isAtBottom) {
      setFollowOutput(true)
      pendingUserScrollUpIntentRef.current = false
    } else if (followOutputRef.current && pendingUserScrollUpIntentRef.current) {
      if (scrolledUp) {
        cancelPendingStickToBottom()
        setFollowOutput(false)
      }
      pendingUserScrollUpIntentRef.current = false
    } else if (followOutputRef.current && isPointerScrollActiveRef.current) {
      if (scrolledUp) {
        cancelPendingStickToBottom()
        setFollowOutput(false)
      }
    }

    lastKnownScrollTopRef.current = currentScrollTop
    updateScrollMetrics()
  }, [cancelPendingStickToBottom, onNearBottomChange, updateScrollMetrics])

  useLayoutEffect(() => {
    if (!isActivationReady) {
      return
    }
    setFollowOutput(true)
    forceStickToBottom()
    const timeout = window.setTimeout(() => {
      console.log('timeout', {
        followOutputRef: followOutputRef.current,
        scrollContainerRef: scrollContainerRef.current,
        isScrollContainerNearBottom: scrollContainerRef.current
          ? isScrollContainerNearBottom(scrollContainerRef.current)
          : null,
      })
      if (!followOutputRef.current) {
        return
      }
      const scrollContainer = scrollContainerRef.current
      if (!scrollContainer) {
        return
      }
      if (isScrollContainerNearBottom(scrollContainer)) {
        return
      }
      scheduleStickToBottom('activation-timeout')
    }, WEB_BOTTOM_SETTLE_TIMEOUT_MS)
    return () => {
      window.clearTimeout(timeout)
    }
  }, [activationKey, forceStickToBottom, isActivationReady, scheduleStickToBottom])

  useEffect(() => {
    if (!followOutputRef.current) {
      return
    }
    scheduleStickToBottom('rows-effect')
  }, [rows, scheduleStickToBottom])

  useEffect(() => {
    if (!followOutputRef.current) {
      return
    }
    if (!webVirtualizedHistoryWindow) {
      return
    }
    scheduleStickToBottom('virtual-total-size-effect')
  }, [scheduleStickToBottom, virtualTotalSize, webVirtualizedHistoryWindow])

  useEffect(() => {
    updateScrollMetrics()
  }, [updateScrollMetrics, virtualTotalSize, rows.length])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    const contentNode = contentRef.current
    if (!scrollContainer || typeof ResizeObserver === 'undefined') {
      return
    }

    updateScrollMetrics()
    const observer = new ResizeObserver(() => {
      updateScrollMetrics()
      if (!followOutputRef.current) {
        return
      }
      scheduleStickToBottom('resize-observer')
    })
    observer.observe(scrollContainer)
    if (contentNode) {
      observer.observe(contentNode)
    }
    return () => {
      observer.disconnect()
    }
  }, [scheduleStickToBottom, updateScrollMetrics])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pendingUserScrollUpIntentRef.current = true
        cancelPendingStickToBottom()
      }
    }
    const handlePointerDown = () => {
      isPointerScrollActiveRef.current = true
    }
    const handlePointerUp = () => {
      isPointerScrollActiveRef.current = false
    }
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      lastTouchClientYRef.current = touch.clientY
    }
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      const previousTouchY = lastTouchClientYRef.current
      if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
        pendingUserScrollUpIntentRef.current = true
        cancelPendingStickToBottom()
      }
      lastTouchClientYRef.current = touch.clientY
    }
    const handleTouchEnd = () => {
      lastTouchClientYRef.current = null
    }

    scrollContainer.addEventListener('scroll', handleDomScroll, { passive: true })
    scrollContainer.addEventListener('wheel', handleWheel, { passive: true })
    scrollContainer.addEventListener('pointerdown', handlePointerDown, { passive: true })
    scrollContainer.addEventListener('pointerup', handlePointerUp, { passive: true })
    scrollContainer.addEventListener('pointercancel', handlePointerUp, { passive: true })
    scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true })
    scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true })
    scrollContainer.addEventListener('touchend', handleTouchEnd, { passive: true })
    scrollContainer.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      scrollContainer.removeEventListener('scroll', handleDomScroll)
      scrollContainer.removeEventListener('wheel', handleWheel)
      scrollContainer.removeEventListener('pointerdown', handlePointerDown)
      scrollContainer.removeEventListener('pointerup', handlePointerUp)
      scrollContainer.removeEventListener('pointercancel', handlePointerUp)
      scrollContainer.removeEventListener('touchstart', handleTouchStart)
      scrollContainer.removeEventListener('touchmove', handleTouchMove)
      scrollContainer.removeEventListener('touchend', handleTouchEnd)
      scrollContainer.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [cancelPendingStickToBottom, handleDomScroll])

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: () => {
        setFollowOutput(true)
        cancelPendingStickToBottom()
        forceStickToBottom()
      },
      prepareForViewportChange: () => {
        if (!followOutputRef.current) {
          return
        }
        scheduleStickToBottom('prepare-for-viewport-change')
      },
    }
    viewportRef.current = handle
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null
      }
      cancelPendingStickToBottom()
    }
  }, [cancelPendingStickToBottom, scheduleStickToBottom, forceStickToBottom, viewportRef])

  const contentContainerStyle = useMemo(
    (): CSSProperties => ({
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100%',
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: isMobileBreakpoint ? 8 : 16,
      paddingRight: isMobileBreakpoint ? 8 : 16,
      boxSizing: 'border-box',
    }),
    [isMobileBreakpoint]
  )
  const scrollContainerStyle = useMemo(
    (): CSSProperties => ({
      flex: 1,
      minHeight: 0,
      overflowX: 'hidden',
      overflowY: scrollEnabled ? 'auto' : 'hidden',
      overscrollBehaviorY: 'contain',
    }),
    [scrollEnabled]
  )
  const headerEdgeContent = renderEdge(edgeSlotProps.ListHeaderComponent)
  const footerEdgeContent = renderEdge(
    edgeSlotProps.ListFooterComponent,
    edgeSlotProps.ListFooterComponentStyle as CSSProperties | undefined
  )
  const virtualRowsContainerStyle = useMemo(
    (): CSSProperties => ({
      position: 'relative',
      width: '100%',
      height: virtualTotalSize,
    }),
    [virtualTotalSize]
  )
  const renderVirtualRowStyle = useCallback(
    (start: number): CSSProperties => ({
      position: 'absolute',
      top: 0,
      left: 0,
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      transform: `translateY(${start}px)`,
    }),
    []
  )

  return (
    <>
      <style id={WEB_STREAM_SCROLLBAR_STYLE_ID}>{WEB_STREAM_SCROLLBAR_STYLE}</style>
      <div
        ref={(node) => {
          scrollContainerRef.current = node
        }}
        data-testid="agent-chat-scroll"
        id={`agent-chat-scroll-${shouldUseVirtualizer ? 'web-dom-virtualized' : 'web-dom-scroll'}`}
        style={scrollContainerStyle}
      >
        <div
          ref={(node) => {
            contentRef.current = node
          }}
          style={contentContainerStyle}
        >
          {headerEdgeContent}
          {webVirtualizedHistoryWindow ? (
            <div style={virtualRowsContainerStyle}>
              {virtualRows.map((virtualRow) => {
                const entry = virtualizedEntries[virtualRow.index]
                if (!entry) {
                  return null
                }
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={renderVirtualRowStyle(virtualRow.start)}
                  >
                    {renderRow(entry.item, entry.index, rows)}
                  </div>
                )
              })}
            </div>
          ) : null}
          {mountedEntries.map((entry) => (
            <Fragment key={entry.item.id}>{renderRow(entry.item, entry.index, rows)}</Fragment>
          ))}
          {rows.length === 0 ? listEmptyComponent : null}
          {footerEdgeContent}
        </div>
      </div>
      <WebDesktopScrollbarOverlay
        enabled={showDesktopWebScrollbar}
        metrics={streamScrollbarMetrics}
        inverted={false}
        onScrollToOffset={(nextOffset) => {
          const scrollContainer = scrollContainerRef.current
          if (!scrollContainer) {
            return
          }
          scrollContainer.scrollTo({ top: nextOffset, behavior: 'auto' })
          lastKnownScrollTopRef.current = scrollContainer.scrollTop
          updateScrollMetrics()
        }}
      />
    </>
  )
}

export function createWebStreamStrategy(input: CreateWebStreamStrategyInput): StreamStrategy {
  return createStreamStrategy({
    render: (renderInput) => (
      <WebStreamViewport
        key={renderInput.agentId}
        {...renderInput}
        isMobileBreakpoint={input.isMobileBreakpoint}
      />
    ),
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: 'footer',
    flatListInverted: false,
    overlayScrollbarInverted: false,
    maintainVisibleContentPosition: undefined,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 0,
      verificationRetryMode: 'rescroll',
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: true,
    animateManualScrollToBottom: false,
    useVirtualizedList: false,
    isNearBottom: (inputMetrics) => {
      const distanceFromBottom = Math.max(
        0,
        inputMetrics.contentHeight - (inputMetrics.offsetY + inputMetrics.viewportHeight)
      )
      return distanceFromBottom <= inputMetrics.threshold
    },
    getBottomOffset: (metrics) => Math.max(0, metrics.contentHeight - metrics.viewportHeight),
  })
}
