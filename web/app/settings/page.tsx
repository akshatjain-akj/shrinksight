"use client";

import { useState } from "react";
import CameraConfig from "@/components/CameraConfig";
import RoleConfig from "@/components/RoleConfig";

const SECTIONS = [
  { id: "cameras", label: "Cameras", hint: "Zones, lanes, detection" },
  { id: "roles", label: "Roles", hint: "Manager and user access" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>("cameras");

  return (
    <div className="settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Store setup for managers. Each area stays in its own section.</p>
        </div>
      </div>
      <div className="settings-switch" role="tablist" aria-label="Settings sections">
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
        <div role="tabpanel" id="settings-panel-roles" aria-labelledby="settings-tab-roles" hidden={section !== "roles"}>
          <RoleConfig />
        </div>
      </div>
    </div>
  );
}
