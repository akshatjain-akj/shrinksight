"use client";

import { useEffect, useState } from "react";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { api } from "@/lib/api";
import type { RosterPerson } from "@/lib/types";

export default function RoleConfig() {
  const [people, setPeople] = useState<RosterPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api
      .users()
      .then(setPeople)
      .catch((err: Error) => setError(err.message));
  }, []);

  const changeRole = async (person: RosterPerson, role: RosterPerson["role"]) => {
    if (role === person.role) return;
    setError(null);
    setNotice(null);
    setSaving(person.id);
    try {
      const updated = await api.setUserRole(person.id, role);
      setPeople((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null);
      setNotice(`${updated.name} is now ${updated.role}. They should sign in again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the role");
    } finally {
      setSaving(null);
    }
  };

  if (error && !people) return <ErrorNotice>{error}</ErrorNotice>;
  if (!people) return <Skeletons count={3} />;

  return (
    <section className="settings-card" aria-label="Role configuration">
      <header className="settings-card-head">
        <div>
          <h2>Roles</h2>
          <p className="hint">Manager keeps Rules and Settings. User works the lanes. The store always keeps one manager.</p>
        </div>
      </header>
      <ul className="role-list">
        {people.map((person) => (
          <li key={person.id}>
            <div>
              <strong>{person.name}</strong>
              <span>{person.email}</span>
            </div>
            <label>
              <span className="visually-hidden">Role for {person.name}</span>
              <select
                value={person.role}
                disabled={saving === person.id}
                onChange={(event) => void changeRole(person, event.target.value as RosterPerson["role"])}
              >
                <option value="manager">Manager</option>
                <option value="user">User</option>
              </select>
            </label>
          </li>
        ))}
      </ul>
      {notice && <p className="hint role-note">{notice}</p>}
      {error && (
        <div className="role-note">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}
    </section>
  );
}
