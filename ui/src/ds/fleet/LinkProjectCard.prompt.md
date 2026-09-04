The dashed invitation to add work to Foreman. **Empty-state only**, centred under the header at `20rem` wide.

```jsx
{projects.length === 0 && <LinkProjectCard onClick={() => setPicker(true)} />}
```

A 22px Plus icon over the label `Link a project` and the hint `or drop a folder anywhere`. Dragging a folder onto the fleet is the second path to the same action, and it keeps working once there are projects.

- Superseded guidance: this tile used to sit as the final cell of a populated grid, and the header button was ruled out. That was wrong in use — as the grid fills, the tile drifts down and right, so the one action that adds work gets harder to find exactly as the fleet gets busier. With projects present the action is a `primary` **Link project** button in `AppHeader`, in a position that does not move.
