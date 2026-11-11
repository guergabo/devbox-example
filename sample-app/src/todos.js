// Pure to-do list logic, kept separate from the DOM so it is easy to test.

export function addTodo(todos, text) {
	const trimmed = text.trim();
	if (!trimmed) return todos;
	return [...todos, { id: Date.now() + Math.random(), text: trimmed, done: false }];
}

export function toggleTodo(todos, id) {
	return todos.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo));
}

export function remainingCount(todos) {
	return todos.filter((todo) => !todo.done).length;
}
