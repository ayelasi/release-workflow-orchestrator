// Drives dashboard interactions and renders workflow state returned by the API.
const state = {
  apiUrl: '',
  workflows: [],
  selectedWorkflowId: null,
  selectedWorkflowStatus: null,
  nextToken: null,
  pollTimer: null,
  loading: false,
};

const taskDefinitions = [
  { taskId: 'A', label: 'Validation' },
  { taskId: 'B1', label: 'Build Verification' },
  { taskId: 'B2', label: 'Artifact Verification' },
  { taskId: 'B3', label: 'Security Scan' },
  { taskId: 'C', label: 'Release Completion' },
];

const terminalStatuses = new Set([
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'SKIPPED',
]);

const elements = {
  form: document.querySelector('#workflow-form'),
  formMessage: document.querySelector('#form-message'),
  refreshButton: document.querySelector('#refresh-button'),
  listMessage: document.querySelector('#list-message'),
  workflowList: document.querySelector('#workflow-list'),
  loadMoreButton: document.querySelector('#load-more-button'),
  detailHeading: document.querySelector('#detail-heading'),
  detailMessage: document.querySelector('#detail-message'),
  workflowStatus: document.querySelector('#workflow-status'),
  progressWrap: document.querySelector('#workflow-progress'),
  progressText: document.querySelector('#progress-text'),
  progressCount: document.querySelector('#progress-count'),
  progressBar: document.querySelector('#progress-bar'),
  workflowSummary: document.querySelector('#workflow-summary'),
  dagContainer: document.querySelector('#dag-container'),
  dag: document.querySelector('#workflow-dag'),
  taskDetails: document.querySelector('#task-details'),
};

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function statusClass(status) {
  return `status-${String(status).toLowerCase().replaceAll('_', '-')}`;
}

function makeStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${statusClass(status)}`;
  badge.textContent = status.replaceAll('_', ' ');
  return badge;
}

function formatDate(value) {
  if (!value) {
    return 'Time unavailable';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function apiEndpoint(path) {
  return new URL(path.replace(/^\/+/, ''), state.apiUrl).toString();
}

async function request(path, options) {
  const result = await fetch(apiEndpoint(path), {
    ...options,
    headers: {
      ...(options?.headers ?? {}),
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) {
    throw new Error(payload.message || `Request failed (${result.status})`);
  }
  return payload;
}

function renderWorkflowList() {
  elements.workflowList.replaceChildren();
  for (const workflow of state.workflows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(
      'aria-current',
      String(workflow.workflowId === state.selectedWorkflowId),
    );
    button.addEventListener('click', () => selectWorkflow(workflow.workflowId));

    const label = document.createElement('span');
    label.className = 'workflow-label';
    const title = document.createElement('strong');
    title.textContent = `${workflow.input.version} · ${workflow.input.environment}`;
    const created = document.createElement('small');
    created.textContent = formatDate(workflow.createdAt);
    label.append(title, created);
    button.append(label, makeStatusBadge(workflow.status));
    item.append(button);
    elements.workflowList.append(item);
  }
  elements.loadMoreButton.hidden = !state.nextToken;
  if (state.workflows.length === 0) {
    setMessage(elements.listMessage, 'No workflows have been started yet.');
  } else {
    setMessage(elements.listMessage, '');
  }
}

async function loadWorkflows(append = false) {
  const query = append && state.nextToken
    ? `?nextToken=${encodeURIComponent(state.nextToken)}`
    : '';
  const result = await request(`workflows${query}`);
  state.workflows = append
    ? [...state.workflows, ...result.workflows]
    : result.workflows;
  state.nextToken = result.nextToken ?? null;
  renderWorkflowList();
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function renderDag(tasks) {
  const positions = {
    A: { x: 25, y: 155 },
    B1: { x: 250, y: 30 },
    B2: { x: 250, y: 155 },
    B3: { x: 250, y: 280 },
    C: { x: 485, y: 155 },
  };
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  elements.dag.replaceChildren();

  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', {
    id: 'arrow',
    markerWidth: 10,
    markerHeight: 10,
    refX: 8,
    refY: 3,
    orient: 'auto',
    markerUnits: 'strokeWidth',
  });
  marker.append(createSvgElement('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#9aabba' }));
  defs.append(marker);
  elements.dag.append(defs);

  for (const task of tasks) {
    const destination = positions[task.taskId];
    for (const dependencyId of task.dependencies) {
      const source = positions[dependencyId];
      const line = createSvgElement('path', {
        d: `M ${source.x + 185} ${source.y + 32} C ${source.x + 215} ${source.y + 32}, ${destination.x - 30} ${destination.y + 32}, ${destination.x - 8} ${destination.y + 32}`,
        class: 'dag-edge',
        'marker-end': 'url(#arrow)',
      });
      elements.dag.append(line);
    }
  }

  for (const definition of taskDefinitions) {
    const task = byId.get(definition.taskId);
    const position = positions[definition.taskId];
    const node = createSvgElement('g', {
      class: `dag-node ${statusClass(task?.status ?? 'PENDING')}`,
    });
    node.append(createSvgElement('rect', {
      x: position.x,
      y: position.y,
      width: 185,
      height: 64,
      rx: 12,
    }));

    const id = createSvgElement('text', {
      x: position.x + 14,
      y: position.y + 22,
      class: 'node-id',
    });
    id.textContent = definition.taskId;
    const label = createSvgElement('text', {
      x: position.x + 14,
      y: position.y + 40,
      class: 'node-label',
    });
    label.textContent = definition.label;
    const status = createSvgElement('text', {
      x: position.x + 14,
      y: position.y + 56,
      class: 'node-status',
    });
    status.textContent = task?.status ?? 'PENDING';
    node.append(id, label, status);
    elements.dag.append(node);
  }
}

function renderTaskDetails(tasks) {
  elements.taskDetails.replaceChildren();
  for (const task of tasks) {
    const card = document.createElement('article');
    card.className = 'task-card';
    const heading = document.createElement('h4');
    const label = document.createElement('span');
    label.textContent = `${task.taskId} · ${task.label}`;
    heading.append(label, makeStatusBadge(task.status));
    card.append(heading);

    const dependencies = document.createElement('p');
    dependencies.textContent = task.dependencies.length
      ? `Depends on ${task.dependencies.join(', ')}`
      : 'No dependencies';
    card.append(dependencies);
    if (task.startedAt) {
      const started = document.createElement('p');
      started.textContent = `Started ${formatDate(task.startedAt)}`;
      card.append(started);
    }
    if (task.finishedAt) {
      const finished = document.createElement('p');
      finished.textContent = `Finished ${formatDate(task.finishedAt)}`;
      card.append(finished);
    }
    if (task.reason) {
      const reason = document.createElement('p');
      reason.textContent = task.reason;
      card.append(reason);
    }
    if (task.result && typeof task.result === 'object') {
      const result = task.result;
      for (const finding of result.findings ?? []) {
        const detail = document.createElement('p');
        detail.textContent = `${finding.severity}: ${finding.description}`;
        card.append(detail);
      }
      if (result.checksum) {
        const checksum = document.createElement('p');
        checksum.textContent = `Checksum: ${result.checksum}`;
        card.append(checksum);
      }
      if (result.message) {
        const message = document.createElement('p');
        message.textContent = result.message;
        card.append(message);
      }
    }
    elements.taskDetails.append(card);
  }
}

function renderWorkflow(workflow) {
  state.selectedWorkflowStatus = workflow.status;
  elements.detailHeading.textContent =
    `${workflow.input.version} · ${workflow.input.environment}`;
  elements.workflowStatus.hidden = false;
  elements.workflowStatus.className = `status-badge ${statusClass(workflow.status)}`;
  elements.workflowStatus.textContent = workflow.status.replaceAll('_', ' ');
  elements.detailMessage.textContent = '';
  elements.progressWrap.hidden = false;
  const terminalCount = workflow.tasks.filter((task) =>
    terminalStatuses.has(task.status),
  ).length;
  elements.progressText.textContent = terminalCount === workflow.tasks.length
    ? 'Workflow finished'
    : 'Workflow progress';
  elements.progressCount.textContent = `${terminalCount} of ${workflow.tasks.length} tasks complete`;
  elements.progressBar.value = terminalCount;

  elements.workflowSummary.replaceChildren();
  const created = document.createElement('span');
  created.textContent = `Created ${formatDate(workflow.createdAt)}`;
  const approval = document.createElement('span');
  approval.textContent = `Approved: ${workflow.input.approved ? 'Yes' : 'No'}`;
  elements.workflowSummary.append(created, approval);
  if (workflow.completedAt) {
    const completed = document.createElement('span');
    completed.textContent = `Finished ${formatDate(workflow.completedAt)}`;
    elements.workflowSummary.append(completed);
  }
  elements.workflowSummary.hidden = false;
  elements.dagContainer.hidden = false;
  renderDag(workflow.tasks);
  renderTaskDetails(workflow.tasks);
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.selectedWorkflowId || state.selectedWorkflowStatus !== 'RUNNING') {
    return;
  }
  state.pollTimer = setTimeout(async () => {
    await refreshSelectedWorkflow();
  }, 3000);
}

async function refreshSelectedWorkflow() {
  if (!state.selectedWorkflowId || state.loading) {
    return;
  }
  state.loading = true;
  try {
    await loadWorkflows();
    const workflow = await request(
      `workflows/${encodeURIComponent(state.selectedWorkflowId)}`,
    );
    renderWorkflow(workflow);
  } catch (error) {
    setMessage(elements.detailMessage, error.message, true);
  } finally {
    state.loading = false;
    renderWorkflowList();
    schedulePoll();
  }
}

async function selectWorkflow(workflowId) {
  state.selectedWorkflowId = workflowId;
  renderWorkflowList();
  await refreshSelectedWorkflow();
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = elements.form.querySelector('button[type="submit"]');
  const formData = new FormData(elements.form);
  submitButton.disabled = true;
  setMessage(elements.formMessage, 'Creating workflow…');
  try {
    const result = await request('workflows', {
      method: 'POST',
      body: JSON.stringify({
        version: formData.get('version'),
        environment: formData.get('environment'),
        approved: formData.has('approved'),
      }),
    });
    state.selectedWorkflowId = result.workflowId;
    await loadWorkflows();
    await refreshSelectedWorkflow();
    setMessage(elements.formMessage, `Workflow ${result.workflowId} started.`);
  } catch (error) {
    setMessage(elements.formMessage, error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

elements.refreshButton.addEventListener('click', async () => {
  try {
    await loadWorkflows();
    if (state.selectedWorkflowId) {
      await refreshSelectedWorkflow();
    }
  } catch (error) {
    setMessage(elements.listMessage, error.message, true);
  }
});

elements.loadMoreButton.addEventListener('click', async () => {
  elements.loadMoreButton.disabled = true;
  try {
    await loadWorkflows(true);
  } catch (error) {
    setMessage(elements.listMessage, error.message, true);
  } finally {
    elements.loadMoreButton.disabled = false;
  }
});

async function initialize() {
  try {
    const configResponse = await fetch('config.json');
    if (!configResponse.ok) {
      throw new Error('Dashboard API configuration could not be loaded');
    }
    const config = await configResponse.json();
    if (typeof config.apiUrl !== 'string' || !config.apiUrl) {
      throw new Error('Dashboard API URL is missing');
    }
    state.apiUrl = config.apiUrl.endsWith('/') ? config.apiUrl : `${config.apiUrl}/`;
    await loadWorkflows();
  } catch (error) {
    setMessage(elements.listMessage, error.message, true);
  }
}

initialize();
