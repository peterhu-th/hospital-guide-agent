const PATIENT_QUERY_TOOLS = Object.freeze({
  get_my_appointments: "APPOINTMENT",
  get_my_prescriptions: "PRESCRIPTION",
  get_my_examinations: "EXAMINATION",
  get_my_all: "ALL",
});

export class AgentToolRegistry {
  constructor({ doctorDirectory, journeyService, taskManager }) {
    this.doctorDirectory = doctorDirectory;
    this.journeyService = journeyService;
    this.taskManager = taskManager;
  }

  execute(name, input, context = {}) {
    if (name === "search_doctors") return this.doctorDirectory.search(input);
    if (name === "list_scheduled_doctors") {
      return input.date
        ? this.doctorDirectory.scheduled(input)
        : this.doctorDirectory.upcoming(input);
    }
    if (Object.hasOwn(PATIENT_QUERY_TOOLS, name)) {
      return this.journeyService.query(context.session, PATIENT_QUERY_TOOLS[name]);
    }
    if (name === "show_current_task") {
      const journey = this.journeyService.journey(context.session);
      const task = this.taskManager.current(journey);
      return task ? { task, journey: this.journeyService.query(context.session, task.journeyFilter) } : null;
    }
    throw new Error(`Unknown agent tool: ${name}`);
  }
}

export const registeredAgentTools = Object.freeze([
  "search_doctors",
  "list_scheduled_doctors",
  ...Object.keys(PATIENT_QUERY_TOOLS),
  "show_current_task",
  "complete_examination",
  "complete_pharmacy_pickup",
  "set_return_visit",
  "check_in_return_visit",
  "export_medical_record",
]);
