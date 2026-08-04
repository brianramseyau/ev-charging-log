<script lang="ts">
	let { path, size = 18 }: { path: string; size?: number } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
	<path fill="currentColor" d={path} />
</svg>
