import { VERSION } from '../../src/version';
import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
	title: 'IWER',
	description: 'Javascript WebXR Runtime Library for Emulation',
	head: [
		[
			'link',
			{ rel: 'icon', href: '/immersive-web-emulation-runtime/iwer.png' },
		],
	],
	base: '/immersive-web-emulation-runtime/',
	themeConfig: {
		// https://vitepress.dev/reference/default-theme-config
		logo: { light: '/iwer-dark.svg', dark: '/iwer.svg' },
		nav: [
			{ text: 'About', link: '/about' },
			{ text: 'Guide', link: '/getting-started' },
			{
				text: 'Terms',
				link: 'https://opensource.fb.com/legal/terms/',
			},
			{
				text: 'Privacy',
				link: 'https://opensource.fb.com/legal/privacy/',
			},
			{
				text: `v${VERSION}`,
				items: [
					{ text: 'NPM', link: 'https://www.npmjs.com/package/iwer' },
					{
						text: 'License',
						link: 'https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/LICENSE',
					},
				],
			},
		],

		sidebar: [
			{
				text: 'Getting Started',
				items: [
					{ text: 'About IWER', link: '/about' },
					{
						text: 'Installation',
						link: '/getting-started#adding-iwer-to-your-project',
					},
					{
						text: 'Runtime Injection',
						link: '/getting-started#creating-an-xrdevice-and-installing-the-runtime',
					},
					{
						text: '🥽 Emulated Headset',
						link: '/getting-started#emulated-headset',
					},
					{
						text: '🎮 Emulated Controllers',
						link: '/getting-started#emulated-controllers',
					},
					{
						text: '🖐️ Emulated Hands',
						link: '/getting-started#emulated-hands',
					},
					{
						text: 'Platform Features',
						link: '/getting-started#platform-features',
					},
					{
						text: 'XPlat Controls',
						link: '/xplat',
					},
				],
			},
			{
				text: 'IWER in Action',
				link: '/action#action-recording-playback',
				items: [
					{ text: 'Live Demo', link: '/action#live-webxr-demo' },
					{ text: 'Action Recording', link: '/action#how-does-recording-work' },
					{ text: 'Action Playback', link: '/action#how-does-playback-work' },
				],
			},
			{
				text: 'API Reference',
				items: [
					{ text: 'XRDevice Class', link: '/api/xr-device' },
					{ text: 'XRController Class', link: '/api/xr-controller' },
					{ text: 'XRHandInput Class', link: '/api/xr-hand-input' },
					{ text: 'Config Interfaces', link: '/api/config-interfaces' },
				],
			},
		],

		socialLinks: [
			{
				icon: 'github',
				link: 'https://github.com/meta-quest/immersive-web-emulation-runtime/',
			},
		],

		search: {
			provider: 'local',
		},

		footer: {
			copyright: 'MIT License | Copyright © Meta Platforms, Inc',
		},
	},
});
