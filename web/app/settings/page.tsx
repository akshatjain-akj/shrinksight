"use client";

import CameraConfig from "@/components/CameraConfig";

export default function SettingsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Draw the detection zone for a store camera and choose what the live scan watches.</p>
        </div>
      </div>
      <CameraConfig />
    </>
  );
}
