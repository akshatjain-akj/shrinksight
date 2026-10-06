"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import CameraConfig from "@/components/CameraConfig";
import RoleConfig from "@/components/RoleConfig";
import RulesDesk from "@/components/RulesDesk";
import ZoneConfig from "@/components/ZoneConfig";

const SECTIONS = [
  { id: "cameras", label: "Cameras", hint: "Lanes and detection" },
  { id: "zones", label: "Zones", hint: "Spots inside a camera" },
  { id: "rules", label: "Rules", hint: "Plain-English store rules" },
  { id: "roles", label: "Roles", hint: "Manager and user access" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function isSection(value: string | null): value is SectionId {
  return value === "cameras" || value === "zones" || value === "rules" || value === "roles";
}

export default function SettingsPage() {
  const params = useSearchParams();
  const requested = params.get("section");
  const [section, setSection] = useState<SectionId>(isSection(requested) ? requested : "cameras");

  useEffect(() => {
    if (isSection(requested)) setSection(requested);
  }, [requested]);

  return (
    <div className="settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Store setup for managers. Each area stays in its own section.</p>
        </div>
      </div>
      <div className="settings-frame">
        <div className="settings-switch" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={item.id === section}
              aria-controls={`settings-panel-${item.id}`}
              className={item.id === section ? "is-on" : ""}
              onClick={() => setSection(item.id)}
            >
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
        <div className="settings-panels">
        <div
          role="tabpanel"
          id="settings-panel-cameras"
          aria-labelledby="settings-tab-cameras"
          hidden={section !== "cameras"}
        >
          <CameraConfig />
        </div>
        <div role="tabpanel" id="settings-panel-zones" aria-labelledby="settings-tab-zones" hidden={section !== "zones"}>
          <ZoneConfig />
        </div>
        <div role="tabpanel" id="settings-panel-rules" aria-labelledby="settings-tab-rules" hidden={section !== "rules"}>
          <RulesDesk />
        </div>
        <div role="tabpanel" id="settings-panel-roles" aria-labelledby="settings-tab-roles" hidden={section !== "roles"}>
          <RoleConfig />
        </div>
        </div>
      </div>
    </div>
  );
}
