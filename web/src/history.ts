import { useCallback, useEffect, useState } from 'react'
import type { Api, Page, Run } from './data'

const pageSize = 30
type Cursor = Pick<Run, 'id' | 'createdAt'>
type Listing = { runs: Run[]; hasOlder: boolean }

export function useRunHistory (api: Api, page: Page, filter: string, onError: (error: unknown) => void) {
  const [pages, setPages] = useState<Cursor[]>([])
  const [listing, setListing] = useState<Listing | null>(null)
  const [updated, setUpdated] = useState(0)
  const active = page === 'runs' || page === 'archives'
  const cursor = pages.at(-1)
  const reload = useCallback(() => setUpdated(previous => previous + 1), [])
  const reset = useCallback(() => { setPages([]); setListing(null) }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    async function read () {
      try {
        const result = await api<Run[]>('runs.list', {
          limit: pageSize + 1,
          ...(filter && { planId: filter }),
          ...(cursor && { before: cursor.createdAt, beforeId: cursor.id }),
          archivesOnly: page === 'archives'
        })
        if (!cancelled) setListing({ runs: result.slice(0, pageSize), hasOlder: result.length > pageSize })
      } catch (err) { if (!cancelled) onError(err) }
    }
    void read()
    const timer = window.setInterval(() => void read(), 4000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, api, cursor, filter, onError, page, updated])

  function older () {
    const last = listing?.runs.at(-1)
    if (!last || !listing?.hasOlder) return
    setListing(null)
    setPages(previous => [...previous, { id: last.id, createdAt: last.createdAt }])
  }
  function newer () {
    setListing(null)
    setPages(previous => previous.slice(0, -1))
  }
  return { listing, pageNumber: pages.length + 1, older, newer, reload, reset }
}
