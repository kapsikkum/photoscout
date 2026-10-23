import { useEffect, useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, AuthStatus } from './api.js';
import { TimeProvider } from './time.js';
import { loadWebPlugins } from './plugins/loader.js';
import { pluginRegistry } from './plugins/registry.js';
import Login from './pages/Login.js';
import MapPage from './pages/MapPage.js';
import PlacePage from './pages/PlacePage.js';
import PlanShoot from './pages/PlanShoot.js';
import ImportExport from './pages/ImportExport.js';
import Settings from './pages/Settings.js';
import Legal from './pages/Legal.js';
import Events from './pages/Events.js';
import Calendar from './pages/Calendar.js';
import Profile from './pages/Profile.js';
import Kit from './pages/Kit.js';
import CommunityEventForm from './pages/CommunityEventForm.js';
import Feed from './pages/Feed.js';
import Chat from './pages/Chat.js';
import Drive from './pages/Drive.js';
import DriveConvoy from './convoy/DriveConvoy.js';
import Moderation from './pages/Moderation.js';
import Convoy from './pages/Convoy.js';
import ConvoySession, { ConvoyNav } from './convoy/ConvoySession.js';

/** What everybody comes for sits in the bar; what is yours, or is a tool, sits under your name. */
const NAV = [['/', 'Map'], ['/events', 'Events'], ['/feed', 'Feed'], ['/chat', 'Chat']] as const;
const MORE = [['/drive', 'Drive'], ['/kit', 'Kit'], ['/plan', 'Plan a shoot'], ['/import', 'Import / export'], ['/settings', 'Settings']] as const;

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const [loadError, setLoadError] = useState('');
  const refresh = () => api.authStatus().then((s) => { setStatus(s); setLoadError(''); }, (err: Error) => setLoadError(err.message));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setMenuOpen(false); setAccountOpen(false); }, [location.pathname]);

  // Web plugins load once the app knows whether this visitor may read anything. A private instance with nobody
  // signed in never asks, so the sign-in redirect below is not preceded by a 401; signing in re-runs this.
  const canRead = !!status && (status.authed || status.publicReads);
  useEffect(() => {
    pluginRegistry.setUser(status?.authed && status.user ? { id: status.user.id, username: status.user.username, role: status.user.role } : null);
  }, [status?.authed, status?.user?.id, status?.user?.username, status?.user?.role]);
  useEffect(() => { if (canRead) void loadWebPlugins(); }, [canRead]);

  if (!status) {
    return (
      <div className="page">
        {loadError
          ? <><p className="status-line error">{loadError}</p><button className="primary" onClick={() => void refresh()}>Try again</button></>
          : <p className="hint">Loading…</p>}
      </div>
    );
  }

  // Visitors browse the public map; everything else asks them to sign in.
  if (location.pathname === '/login') {
    if (status.authed) return <Navigate to="/" replace />;
    return <Login providers={status.providers} />;
  }

  // A private instance (publicReads === false) has no anonymous reads, so a
  // signed-out visitor would otherwise land on a map where every call 401s.
  // Send them to sign in; the legal pages stay reachable.
  if (!status.authed && !status.publicReads && !['/privacy', '/terms'].includes(location.pathname)) {
    return <Navigate to="/login" replace />;
  }

  async function logout() {
    await api.logout();
    await refresh();
    navigate('/login');
  }

  const user = status.authed ? status.user : null;
  const active = (path: string) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path) || (path === '/events' && location.pathname === '/calendar'));

  return (
    <TimeProvider>
      <div className="topbar">
        <button
          className="topbar__burger"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen}
        >
          {menuOpen ? (
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4L16 16M16 4L4 16" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          )}
        </button>
        <Link className="logo" to="/" aria-label="PhotoScout home">
          <svg className="logo__cone" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 3 25 25H7L16 3Z" fill="#f97316" />
            <path d="M12.7 11h6.6l1.5 4H11.2l1.5-4ZM9.5 20h13l1.5 4H8l1.5-4Z" fill="#f8fafc" />
            <path d="M5 25h22l2 4H3l2-4Z" fill="#f59e0b" />
          </svg>
          <span className="logo__wordmark">Photo<span>Scout</span></span>
        </Link>
        <nav className={menuOpen ? 'is-open' : ''}>
          {NAV.filter(([path]) => user || path !== '/chat').map(([path, label]) => (
            <Link key={path} to={path} className={active(path) ? 'active' : ''}>{label}</Link>
          ))}
          {user && (
            <ConvoyNav key={`convoy-nav-${user.id}`} />
          )}
          {user && (
            <div className="account">
              <button type="button" className={`account__button${MORE.some(([p]) => active(p)) || active('/u/') || active('/moderation') ? ' active' : ''}`}
                aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen(!accountOpen)}>{user.username} ▾</button>
              <div className={`account__menu${accountOpen ? ' is-open' : ''}`}>
                <Link to={`/u/${encodeURIComponent(user.username)}`} className={active('/u/') ? 'active' : ''}>Profile</Link>
                {MORE.map(([path, label]) => (
                  <Link key={path} to={path} className={active(path) ? 'active' : ''}>{label}</Link>
                ))}
                {(user.role === 'admin' || user.role === 'moderator') && <Link to="/moderation" className={active('/moderation') ? 'active' : ''}>Moderation</Link>}
                <button type="button" onClick={() => void logout()}>Sign out</button>
              </div>
            </div>
          )}
        </nav>
        {!user && <Link className="topbar__signin" to="/login">Sign in</Link>}
      </div>
      {accountOpen && <div className="account__scrim" onClick={() => setAccountOpen(false)} />}
      {menuOpen && <div className="topbar__scrim" onClick={() => setMenuOpen(false)} />}
      {user && <ConvoySession key={user.id} />}
      <Routes>
        <Route path="/places/:id" element={<PlacePage />} />
        <Route path="/events" element={<Events user={user} />} />
        <Route path="/events/c/:id" element={<Events user={user} />} />
        <Route path="/events/new" element={<CommunityEventForm user={user} />} />
        <Route path="/events/:id/edit" element={<CommunityEventForm user={user} />} />
        <Route path="/events/:group" element={<Events user={user} />} />
        <Route path="/drive" element={<Drive user={user}><DriveConvoy /></Drive>} />
        <Route path="/feed" element={<Feed user={user} />} />
        <Route path="/chat" element={<Chat user={user} />} />
        <Route path="/convoy" element={<Convoy user={user} />} />
        <Route path="/moderation" element={<Moderation user={user} />} />
        <Route path="/calendar" element={<Calendar user={user} />} />
        <Route path="/u/:username" element={<Profile user={user} />} />
        <Route path="/kit" element={<Kit user={user} onChange={refresh} />} />
        <Route path="/plan" element={<PlanShoot />} />
        <Route path="/trip" element={<Navigate to={`/plan${location.search}`} replace />} />
        <Route path="/import" element={<ImportExport />} />
        <Route path="/privacy" element={<Legal page="privacy" />} />
        <Route path="/terms" element={<Legal page="terms" />} />
        <Route path="/settings" element={<Settings user={user} account={status.account} onChange={refresh} />} />
        <Route path="*" element={<MapPage user={user} />} />
      </Routes>
    </TimeProvider>
  );
}
