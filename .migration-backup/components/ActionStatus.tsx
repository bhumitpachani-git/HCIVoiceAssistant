"use client";

import { Check, ShieldCheck, X } from "lucide-react";
import type { CurrentAction } from "@/lib/types";

export type ActionToast = {
  id: string;
  tone: "success" | "error" | "info";
  title: string;
  message: string;
  detail?: string;
};

type ActionStatusProps = {
  action?: CurrentAction;
  toasts: ActionToast[];
  onConfirm: (confirmationId: string, approved: boolean) => void;
};

export const toolLabels: Record<string, string> = {
  run_demo_scenario: "Run Demo Scenario",
  set_room_status: "Set Room Status",
  set_jeron_call: "Set Jeron Call",
  set_ascom_alert: "Set Ascom Alert",
  manage_device_alert: "Manage Device Alert",
  prescribe_media_content: "Prescribe Media Content",
  manage_device_infotiles: "Manage Device Infotiles",
  manage_device_schedule: "Manage Device Schedule",
  update_patient_board: "Update Patient Board",
  set_patient_status: "Set Patient Status",
  set_staff_presence: "Set Staff Presence",
  set_careteam_member: "Set Careteam Member",
  publish_kuzzle_event: "Publish Kuzzle Event",
  set_theme_mode: "Set Theme / Mode",
  list_hci_devices: "List HCI Devices",
  start_hci_meeting: "Start HCI Meeting",
  set_transport_rounding: "Set Transport Rounding",
  set_evs_rounding: "Set EVS Rounding",
  set_maintenance_rounding: "Set Maintenance Rounding",
  set_reassess_rounding: "Set Reassess Rounding",
  set_next_round_timing: "Set Next Round Timing",
  set_rounding_event: "Set Rounding Event"
};

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function summarizeArgs(args?: Record<string, unknown>) {
  if (!args) {
    return undefined;
  }

  const summary = Object.entries(args)
    .map(([key, value]) => {
      const formatted = formatValue(value);
      return formatted ? `${key.replaceAll("_", " ")}: ${formatted}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 4)
    .join(" | ");

  if (!summary) {
    return undefined;
  }

  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
}

export function getToolLabel(name: string) {
  return toolLabels[name] ?? name;
}

export function ActionStatus({ action, toasts, onConfirm }: ActionStatusProps) {
  const hasConfirmation = Boolean(action?.confirmationId && !action.result);
  const confirmationAction = hasConfirmation ? action : undefined;
  const actionSummary = summarizeArgs(confirmationAction?.args);

  return (
    <>
      {toasts.length > 0 ? (
        <section className="toast-stack" aria-live="polite" aria-label="Task updates">
          {toasts.map((toast) => (
            <article className={`toast-card ${toast.tone}`} key={toast.id}>
              <div className="toast-heading">
                <strong>{toast.title}</strong>
              </div>
              <p>{toast.message}</p>
              {toast.detail ? <span>{toast.detail}</span> : null}
            </article>
          ))}
        </section>
      ) : null}

      {confirmationAction ? (
        <section className="confirm-card" aria-label="Approval required">
          <div className="confirm-card-header">
            <span>Approval required</span>
            <ShieldCheck size={18} />
          </div>
          <h2>{getToolLabel(confirmationAction.name)}</h2>
          <p>Please confirm before HCI sends this change to the room system.</p>
          {actionSummary ? <div className="confirm-summary">{actionSummary}</div> : null}
          <div className="confirm-row">
            <button
              className="primary-button"
              onClick={() => onConfirm(confirmationAction.confirmationId!, true)}
              type="button"
            >
              <Check size={18} />
              Confirm
            </button>
            <button
              className="danger-button"
              onClick={() => onConfirm(confirmationAction.confirmationId!, false)}
              type="button"
            >
              <X size={18} />
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
