# venn_diagram_viz_for_dashboard_studio

A custom visualization for Splunk Dashboard Studio

## Project Info

- **Display Label:** Venn Diagram Viz For Dashboard Studio
- **Author:** Daniel Spavin
- **App ID:** venn_diagram_viz_for_dashboard_studio

App metadata (version, label, author, description, category) is stored in `package/app/app.conf`. Edit that file to change how the app appears in Splunk; `package.json` is for Node/npm only.

## Getting Started

```bash
# Install dependencies
yarn install

# Build the visualization
yarn build

# Package into Splunk app
yarn package
```

## Local Preview

Test your visualization in the browser without a running Splunk instance:

```bash
yarn preview
```

This starts Storybook at **http://localhost:6006** with a live preview of your viz rendered inside a sandboxed iframe. Use the **Controls** panel to switch between light and dark themes, adjust the preview height, and edit the sample data sent to your viz.

To see code changes reflected automatically, run `yarn dev` in a separate terminal alongside `yarn preview`. The preview will reload when the build updates.

The preview iframe uses a mock `DashboardExtensionAPI` that behaves identically to the real one in Dashboard Studio. Your visualization code does not need to change between preview and production.

## Project Structure

```
venn_diagram_viz_for_dashboard_studio/
├── package.json                              # Node/npm scripts and dependencies
├── package/
│   └── app/
│       └── app.conf                          # Splunk app metadata (id, version, label, author, description)
└── visualizations/                            # Visualizations directory
    └── venn_diagram_viz_for_dashboard_studio/                        # Your visualization
        ├── src/
        │   └── visualization.jsx             # Visualization code (React)
        └── config.json                       # Visualization metadata
```

Edit `package/app/app.conf` to customize app identity, version, label, and other Splunk app settings. This structure supports multiple visualizations in one project!

## Development

Edit `visualizations/venn_diagram_viz_for_dashboard_studio/src/visualization.jsx` to customize your visualization using React and the `@splunk/dashboard-studio-extension/react` hooks (e.g. `useDataSources()`).

## Adding More Visualizations

To add another visualization to this project:

1. Create a new directory under `visualizations/`:
   ```bash
   mkdir visualizations/my-new-viz
   ```

2. Add the required files:
   ```bash
   mkdir visualizations/my-new-viz/src
   touch visualizations/my-new-viz/src/visualization.jsx
   touch visualizations/my-new-viz/config.json
   ```

3. Implement your visualization in `src/visualization.jsx` (React component)

4. Configure metadata in `config.json`

5. Run `yarn build && yarn package` - it will automatically include all visualizations!

## Packaging

Run `yarn package` to create a `.spl` Splunk app archive ready for deployment.

The packager reads app metadata (id, version, label, author, description) from `package/app/app.conf` and automatically discovers all visualizations in the `visualizations/` directory.

For a production/release build (minified, no source maps in the .spl), run `yarn build:prod` then `yarn package` instead of `yarn build` then `yarn package`.
