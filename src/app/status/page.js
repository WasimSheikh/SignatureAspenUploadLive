import Brand from "@/components/Brand";

const LIVE = "https://signaturefileupload-c3gna0hwffapbfc0.westus3-01.azurewebsites.net";

const LINKS = [
  ["Upload Art", `${LIVE}/`],
  ["Dashboard", `${LIVE}/dashboard`],
  ["Job list", `${LIVE}/dashboard?tab=files`],
  ["Calendar", `${LIVE}/dashboard?tab=calendar`],
  ["File explorer", `${LIVE}/dashboard?tab=browse`],
  ["Employee sign-in", `${LIVE}/api/auth/login`],
];

const FEATURES = [
  {
    title: "Upload Art",
    href: `${LIVE}/`,
    image: "/status/01-upload-art.png",
    alt: "Upload Art page for sending design files",
    body: "Customers and staff can drop artwork on the public page — no account required. After Microsoft sign-in, the same page uses a slimmer banner so it does not jump when you switch from Dashboard.",
  },
  {
    title: "Employee dashboard",
    href: `${LIVE}/dashboard`,
    image: "/status/02-dashboard-overview.png",
    alt: "Dashboard overview with live transfer statistics",
    body: "Overview shows live transfers, file count, total size, companies, this month, today, and jobs expiring in 7 days. Dates use Houston time. Request files from customer is the navy button — it emails the customer a prefilled upload link.",
  },
  {
    title: "Calendar",
    href: `${LIVE}/dashboard?tab=calendar`,
    image: "/status/03-calendar.png",
    alt: "Houston-date calendar of received transfers",
    body: "Month view of transfers received that Houston date. Open a day to download or share every job from that day.",
  },
  {
    title: "Job list",
    href: `${LIVE}/dashboard?tab=files`,
    image: "/status/04-job-list.png",
    alt: "Job list with search and download actions",
    body: "One card per transfer. Search by client, project, or filename. Cloud download, share link, assign to a teammate, or pull a local NAS copy on the office network or VPN.",
  },
  {
    title: "File explorer",
    href: `${LIVE}/dashboard?tab=browse`,
    image: "/status/05-file-explorer.png",
    alt: "File explorer grouped by date",
    body: "SharePoint-style folders. Browse the library, or group by date or company. Search works across file name, company, and job title. Download a single file or ZIP a folder.",
  },
];

export const metadata = {
  title: "Development status | Signature Aspen File Delivery",
  description: "What shipped on the Signature Aspen file delivery workspace.",
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  return (
    <main>
      <header className="slim-header">
        <Brand />
        <nav className="site-nav" aria-label="Site">
          <a href="/">Upload Art</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/status" className="on" aria-current="page">Status</a>
        </nav>
        <a className="employee-login" href="/api/auth/login">Employee sign-in →</a>
      </header>

      <section className="hero slim">
        <div className="hero-wrap">
          <p className="status-kicker">File Delivery · October 27, 2026</p>
          <h1>Development status</h1>
          <p>Employee workspace, date folders in Azure, and corrected staff email links. Share this page to review what shipped.</p>
        </div>
      </section>

      <article className="card status-page">
        <p>
          The employee workspace is live. Customers still send files from Upload Art. Staff now have a dashboard
          with statistics, a Houston-date calendar, a job list, and a SharePoint-style file explorer. New uploads
          are stored in Azure by date. The daily-summary button <strong>See all uploads</strong> now opens the
          dashboard instead of the public upload form.
        </p>

        <h2>Live app</h2>
        <ul className="status-links">
          {LINKS.map(([label, href]) => (
            <li key={href}>
              <span>{label}</span>
              <a href={href}>{href.replace(LIVE, "") || "/"}</a>
            </li>
          ))}
        </ul>
        <p className="muted">
          Sign in with your Signature Aspen Microsoft account. Admins see every live transfer. Everyone else sees
          transfers they uploaded or that were assigned to them. Expired transfers stay hidden.
        </p>

        {FEATURES.map((feature, index) => (
          <section key={feature.title} className="status-feature">
            <h2>
              <span>{index + 1}.</span> {feature.title}
            </h2>
            <p>{feature.body}</p>
            <p className="status-open"><a href={feature.href}>Open {feature.title.toLowerCase()} →</a></p>
            <figure>
              <img src={feature.image} alt={feature.alt} />
            </figure>
          </section>
        ))}

        <section className="status-feature">
          <h2><span>6.</span> Date folders in Azure</h2>
          <p>
            New uploads land in the <strong>design-transfers</strong> container as a virtual folder path.
            The date is Houston (America/Chicago), not UTC. Existing files stay on their original path.
            Nothing was migrated.
          </p>
          <p className="status-path">transfers/YYYY/MM/DD/{"{transferId}"}/{"{fileId}"}</p>
        </section>

        <section className="status-feature">
          <h2><span>7.</span> Email links</h2>
          <ul>
            <li><strong>See all uploads</strong> (daily summary) → dashboard Job list</li>
            <li>Job titles in that summary → that transfer page</li>
            <li>Customer “View your transfer” and internal “Download all” → that transfer page</li>
            <li>“Send your files” (request-files email) → Upload Art with job and contact filled in</li>
          </ul>
          <p className="muted">Emails already in inboxes still have the old See all uploads link. New summaries use the dashboard.</p>
        </section>
      </article>

      <footer>713.830.9500 · 3300 Kingswood St, Houston TX 77092 · Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
