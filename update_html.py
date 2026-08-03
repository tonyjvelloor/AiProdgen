import os
import re

public_dir = '/Users/tonyvelloor/Documents/antigravity/ai-product-catalogue-saas/public'

# Define replacements
replacements = {
    r'<script src="https://cdn.tailwindcss.com"></script>': '<link rel="stylesheet" href="/index.css">',
    r'<script>\s*tailwind\.config.*?<\/script>': '',
    r'class="[^"]*?btn[^"]*?"': 'class="btn btn-primary"',
    r'class="[^"]*?bg-white[^"]*?rounded-xl[^"]*?shadow-sm[^"]*?"': 'class="card"',
    r'class="[^"]*?bg-gray-900[^"]*?rounded-2xl[^"]*?"': 'class="glass-panel"',
    r'text-gray-500': 'text-muted',
    r'text-gray-400': 'text-muted',
    r'text-gray-300': 'text-muted',
    r'text-gray-600': 'text-muted',
    r'text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-600': 'text-gradient',
    r'text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600': 'text-gradient',
    r'text-transparent bg-clip-text bg-gradient-to-r from-brand-600 to-brand-400': 'text-gradient',
    r'bg-gradient-to-r from-indigo-600 to-purple-600': 'gradient-bg',
    r'class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"': 'class="container"',
    r'class="container mx-auto px-4"': 'class="container"',
    r'text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl': 'h2',
    r'text-4xl font-extrabold text-gray-900 sm:text-5xl sm:tracking-tight lg:text-6xl': 'h1',
}

for filename in os.listdir(public_dir):
    if filename.endswith('.html'):
        filepath = os.path.join(public_dir, filename)
        with open(filepath, 'r') as f:
            content = f.read()
            
        # apply regex replacements
        for pattern, replacement in replacements.items():
            content = re.sub(pattern, replacement, content, flags=re.DOTALL)
            
        with open(filepath, 'w') as f:
            f.write(content)

print('Updated all HTML files.')
