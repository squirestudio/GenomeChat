import { useState, useEffect, useCallback } from 'react'
import App from './App.jsx'
import AboutPage from './about.jsx'
import { PrivacyPage, TermsPage } from './legal.jsx'
import FaqPage from './faq.jsx'

/**
 * Minimal path routing, deliberately not a router.
 *
 * It sits above App rather than inside it because App is one very large
 * component with a great many hooks; an early return in there for a second view
 * would be one reordering away from breaking the rules of hooks. Here there is
 * nothing to get wrong.
 *
 * Vercel rewrites every path to index.html (frontend/vercel.json), so /about is
 * a real, linkable, crawlable URL that arrives here as a pathname.
 *
 * Its own file rather than main.jsx so fast refresh can track it — an entry
 * point that also defines a component loses hot reloading for the whole tree.
 */
const normalise = () => window.location.pathname.replace(/\/+$/, '') || '/'

export default function Root() {
  const [path, setPath] = useState(normalise)

  useEffect(() => {
    // Back and forward have to work, or a shared /about link is a dead end for
    // whoever arrived on it.
    const onPop = () => setPath(normalise())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to) => {
    window.history.pushState({}, '', to)
    setPath(normalise())
    window.scrollTo(0, 0)
  }, [])

  if (path === '/about') return <AboutPage onBack={() => navigate('/')} />
  if (path === '/faq') return <FaqPage onBack={() => navigate('/')} />
  if (path === '/privacy') return <PrivacyPage onBack={() => navigate('/')} />
  if (path === '/terms') return <TermsPage onBack={() => navigate('/')} />
  return <App onNavigate={navigate} />
}
