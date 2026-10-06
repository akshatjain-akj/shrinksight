import Link from "next/link";

const LINKS = [
  { href: "/about#problem", label: "The problem" },
  { href: "/about#how", label: "How it works" },
  { href: "/about#privacy", label: "Privacy" },
  { href: "/about#cloud", label: "Google Cloud" },
];

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav className="site-footer-links" aria-label="About">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
