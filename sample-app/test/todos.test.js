import { describe, expect, it } from "vitest";
import { addTodo, remainingCount, toggleTodo } from "../src/todos.js";

describe("todos", () => {
	it("adds a trimmed todo and ignores blank input", () => {
		const todos = addTodo([], "  buy milk  ");
		expect(todos.map((todo) => todo.text)).toEqual(["buy milk"]);
		expect(addTodo(todos, "   ")).toBe(todos);
	});

	it("toggles only the matching todo", () => {
		const todos = addTodo(addTodo([], "a"), "b");
		const toggled = toggleTodo(todos, todos[1].id);
		expect(toggled.map((todo) => todo.done)).toEqual([false, true]);
	});

	it("counts todos that are not done", () => {
		const todos = addTodo(addTodo(addTodo([], "a"), "b"), "c");
		expect(remainingCount(toggleTodo(todos, todos[0].id))).toBe(2);
	});
});
