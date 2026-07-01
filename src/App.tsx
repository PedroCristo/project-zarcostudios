import { Navbar } from "./components/layout/Navbar";
import { Footer } from "./components/layout/Footer";
import { Hero } from "./components/sections/Hero";
import { TrustWidget } from "./components/sections/TrustWidget";
import { Services } from "./components/sections/Services";
import { WhatWeDo } from "./components/sections/WhatWeDo";
import { Portfolio } from "./components/sections/Portfolio";
import { Testimonials } from "./components/sections/Testimonials";
import { Contact } from "./components/sections/Contact";
import { Newsletter } from "./components/sections/Newsletter";

import { About as AboutPage } from "./components/pages/About";
import { Login as LoginPage } from "./components/pages/Login";
import { NotFound as NotFoundPage } from "./components/pages/NotFound";
import { Pricing as PricingPage } from "./components/pages/Pricing";
import { Privacy as PrivacyPage } from "./components/pages/Privacy";
import { Cookies as CookiesPage } from "./components/pages/Cookies";
import { Terms as TermsPage } from "./components/pages/Terms";
import { ProjectDetails as ProjectDetailsPage } from "./components/pages/PortfolioProjectDetails";
import { ProjectHub } from "./components/pages/ProjectHub";
import { AdminDashboard } from "./components/admin/AdminDashboard";
import { Maintenance as MaintenancePage } from "./components/pages/Maintenance";

import { BackToTop } from "./components/ui/BackToTop";
import { Preloader } from "./components/ui/Preloader";
import { CookieConsent } from "./components/ui/CookieConsent";
import { WhatsAppButton } from "./components/ui/WhatsAppButton";

import { motion, useScroll, useSpring } from "motion/react";

import { useState, useEffect } from "react";
import { doc, getDocFromServer, onSnapshot } from "firebase/firestore";
import { db } from "./lib/firebase";

export default function App() {
  const [appReady, setAppReady] = useState(false);
  const [currentHash, setCurrentHash] = useState(window.location.hash);
  const [showMaintenance, setShowMaintenance] = useState(false);

  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001,
  });

  // ---------------- BOOTSTRAP ----------------
  useEffect(() => {
    async function bootstrap() {
      const start = Date.now();

      try {
        await getDocFromServer(doc(db, "test", "connection"));
      } catch (error) {
        console.error("Firebase connection issue:", error);
      }

      const elapsed = Date.now() - start;
      const remaining = 2000 - elapsed;

      if (remaining > 0) {
        setTimeout(() => {
          setAppReady(true);
        }, remaining);
      } else {
        setAppReady(true);
      }
    }

    bootstrap();
  }, []);

  // ---------------- FIREBASE + ROUTING ----------------
  useEffect(() => {
    const unsubSettings = onSnapshot(
      doc(db, "settings", "company-legal"),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          setShowMaintenance(!!data.showMaintenance);
        }
      }
    );

    const handleHashChange = () => {
      setCurrentHash(window.location.hash);
      window.scrollTo(0, 0);
    };

    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
      unsubSettings();
    };
  }, []);

  // redirect clean URLs → hash router
  useEffect(() => {
    if (window.location.pathname.startsWith("/project-hub/")) {
      const pId = window.location.pathname.replace("/project-hub/", "");
      const search = window.location.search;
      window.location.replace(
        `${window.location.origin}/#project-hub/${pId}${search}`
      );
    }
  }, []);

  // ---------------- GLOBAL LOADING GATE ----------------
  if (!appReady) {
    return <Preloader />;
  }

  // ---------------- ROUTES ----------------
  const isAdmin = currentHash === "#admin";
  const isAbout = currentHash === "#about";
  const isLogin = currentHash === "#login";
  const isWork = currentHash === "#work" || currentHash === "#work-archive";
  const isServices = currentHash === "#services";
  const isPricing = currentHash === "#pricing";
  const isContact = currentHash === "#contact";
  const isPrivacy = currentHash === "#privacy";
  const isCookies = currentHash === "#cookies";
  const isTerms = currentHash === "#terms";

  const isProjectDetail = currentHash.startsWith("#project/");
  const projectId = isProjectDetail
    ? currentHash.replace("#project/", "").split("?")[0]
    : null;

  const isProjectHub = currentHash.startsWith("#project-hub/");
  const hubProjectId = isProjectHub
    ? currentHash.replace("#project-hub/", "").split("?")[0]
    : null;

  const validHashes = [
    "",
    "#admin",
    "#about",
    "#login",
    "#work",
    "#work-archive",
    "#services",
    "#pricing",
    "#contact",
    "#privacy",
    "#cookies",
    "#terms",
  ];

  const is404 =
    !validHashes.includes(currentHash) && !isProjectDetail && !isProjectHub;

  // ---------------- ADMIN ----------------
  if (isAdmin) {
    return <AdminDashboard onLogout={() => (window.location.hash = "")} />;
  }

  // ---------------- MAINTENANCE ----------------
  if (showMaintenance && !isLogin && !isProjectHub) {
    return <MaintenancePage />;
  }

  // ---------------- PROJECT HUB ----------------
  if (isProjectHub && hubProjectId) {
    return (
      <div className="relative min-h-screen bg-zarco-black text-white overflow-hidden">
        <Preloader />
        <WhatsAppButton />
        <ProjectHub projectId={hubProjectId} />
        <BackToTop />
      </div>
    );
  }

  // ---------------- MAIN APP ----------------
  return (
    <div className="relative min-h-screen bg-zarco-black text-white overflow-hidden">
      <CookieConsent />
      <WhatsAppButton />

      {/* background glow */}
      <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-zarco-cyan/10 blur-[120px]" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[600px] h-[600px] bg-zarco-purple/10 blur-[150px]" />

      {/* progress bar */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-1 bg-zarco-cyan origin-left z-[60]"
        style={{ scaleX }}
      />

      <Navbar />

      <main>
        {isLogin ? (
          <LoginPage />
        ) : isAbout ? (
          <AboutPage />
        ) : isProjectDetail && projectId ? (
          <ProjectDetailsPage projectId={projectId} />
        ) : isWork ? (
          <div className="pt-32 min-h-[70vh]">
            <Portfolio featuredOnly={false} />
          </div>
        ) : isServices ? (
          <div className="pt-32 min-h-[70vh]">
            <Services />
          </div>
        ) : isPricing ? (
          <PricingPage />
        ) : isPrivacy ? (
          <PrivacyPage />
        ) : isCookies ? (
          <CookiesPage />
        ) : isTerms ? (
          <TermsPage />
        ) : isContact ? (
          <div className="pt-32 min-h-[70vh]">
            <Contact />
          </div>
        ) : is404 ? (
          <NotFoundPage />
        ) : (
          <>
            <Hero />
            <TrustWidget />
            <Services />
            <WhatWeDo />
            <div id="pricing-section">
              <PricingPage />
            </div>
            <Portfolio featuredOnly />
            <Testimonials />
            <Contact />
            <Newsletter />
          </>
        )}
      </main>

      <Footer />
      <BackToTop />
    </div>
  );
}
