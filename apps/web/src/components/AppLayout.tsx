import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, Link } from "react-router-dom";
import {
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  LayoutDashboard,
  Menu,
  Plus,
  Settings2,
  UsersRound,
} from "lucide-react";
import { Button, Modal, Wordmark } from "../ui";
import { prettyZone } from "../time";
import { useWorkspace } from "../workspace-context";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/posts", label: "Posts", icon: FileText },
  { path: "/accounts", label: "Accounts", icon: UsersRound },
  { path: "/settings", label: "Settings", icon: Settings2 },
];

export function AppLayout() {
  const { user, createPost } = useWorkspace();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const current =
    navItems.find((item) => item.path === location.pathname)?.label ||
    "Dashboard";
  useEffect(() => {
    document.title = `${current} · ThreadFlow`;
  }, [current]);
  const navigation = (
    <>
      <div className="sidebar-top">
        <Wordmark />
      </div>
      <div className="workspace-label">
        <span className="workspace-icon">
          {user.name.charAt(0).toUpperCase()}
        </span>
        <div>
          <strong>My workspace</strong>
          <span>Personal workspace</span>
        </div>
      </div>
      <nav aria-label="Main navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            onClick={() => setMenu(false)}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            <item.icon size={19} />
            <span>{item.label}</span>
            {item.path === "/" && <span className="nav-indicator" />}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-create">
        <Button
          onClick={() => {
            setMenu(false);
            createPost();
          }}
        >
          <Plus size={18} />
          Create post
        </Button>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-note">
          <CalendarDays size={20} />
          <strong>A clear week starts here.</strong>
          <p>Give your next idea a place on the calendar.</p>
          <Link to="/calendar" onClick={() => setMenu(false)}>
            Open calendar
            <ChevronRight size={14} />
          </Link>
        </div>
        <button
          className="sidebar-help"
          onClick={() => {
            setMenu(false);
            setHelp(true);
          }}
        >
          <CircleHelp size={17} />
          Getting started
        </button>
        <Link
          to="/settings"
          className="user-menu"
          onClick={() => setMenu(false)}
        >
          <span className="user-avatar">
            {user.name
              .split(" ")
              .map((part) => part.charAt(0))
              .slice(0, 2)
              .join("")}
          </span>
          <span>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </span>
          <Settings2 size={17} />
        </Link>
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">{navigation}</aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-current">
            <button
              className="icon-button mobile-menu-toggle"
              onClick={() => setMenu(true)}
              aria-label="Open navigation"
            >
              <Menu size={21} />
            </button>
            <span className="desktop-breadcrumb">
              Workspace
              <ChevronRight size={14} />
            </span>
            <strong>{current}</strong>
          </div>
          <div className="topbar-right">
            <Link
              to="/settings"
              className="timezone-link"
              title={user.timezone}
            >
              {prettyZone(user.timezone)} time
            </Link>
            <Button
              variant="secondary"
              className="topbar-create"
              onClick={() => createPost()}
            >
              <Plus size={16} />
              New post
            </Button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>Your content, in flow.</span>
          <span>ThreadFlow</span>
        </footer>
      </div>
      <Modal open={menu} onOpenChange={setMenu} title="Your workspace">
        <div className="mobile-navigation">{navigation}</div>
      </Modal>
      <Modal
        open={help}
        onOpenChange={setHelp}
        title="Make yourself at home"
        description="Three steps to get your content into flow."
      >
        <div className="getting-started">
          <div>
            <span>1</span>
            <section>
              <h3>Connect your accounts</h3>
              <p>
                Open Accounts and sign in yourself in the separate Threads
                window. Save a separate session for each real profile.
              </p>
            </section>
          </div>
          <div>
            <span>2</span>
            <section>
              <h3>Save your ideas</h3>
              <p>
                Write a post and save it as a draft while you plan your content.
              </p>
            </section>
          </div>
          <div>
            <span>3</span>
            <section>
              <h3>Return to your accounts</h3>
              <p>
                Verify the saved session before using it. Open Threads restores
                the selected profile in its own browser window.
              </p>
            </section>
          </div>
          <p className="help-timezone">
            <Check size={17} />
            Dates and times use {user.timezone}.
          </p>
          <Button
            onClick={() => {
              setHelp(false);
              createPost();
            }}
          >
            <Plus size={16} />
            Create your first post
          </Button>
        </div>
      </Modal>
    </div>
  );
}
