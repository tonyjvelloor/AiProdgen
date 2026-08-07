const JOB_REGISTRY = [
  {
    id: 'original_upload',
    title: 'Product Overview',
    description: 'The raw product images and initial brief.',
    status: 'active',
    weight: 10,
    estimated_outputs: 1,
    estimated_time: 'instant',
    recommended_after: null,
    milestone_name: 'Product Ready',
    icon: 'upload'
  },
  {
    id: 'photography',
    title: 'Product Photos',
    description: 'Generate professional product photography in various styles and settings.',
    status: 'active',
    weight: 20,
    estimated_outputs: 4,
    estimated_time: '45 sec',
    recommended_after: ['original_upload'],
    milestone_name: 'Commerce Readiness',
    icon: 'camera'
  },
  {
    id: 'commerce',
    title: 'Sell Online',
    description: 'Optimized mixed-media launch packs for Amazon and Shopify.',
    status: 'active',
    weight: 20,
    estimated_outputs: 8,
    estimated_time: '120 sec',
    recommended_after: ['photography'],
    milestone_name: 'Commerce Readiness',
    icon: 'shopping-bag'
  },
  {
    id: 'campaign_blueprint',
    title: 'Campaign Blueprint',
    description: 'Generate strategic campaign hypotheses (Audience, Hook, Offer, Copy).',
    status: 'active',
    weight: 20,
    estimated_outputs: 4,
    estimated_time: '3 min',
    recommended_after: ['commerce'],
    milestone_name: 'Strategy Ready',
    icon: 'target'
  },
  {
    id: 'campaign_production',
    title: 'Campaign Production',
    description: 'Produce complete visual packs for selected blueprint concepts.',
    status: 'active',
    weight: 15,
    estimated_outputs: 5,
    estimated_time: '5 min',
    recommended_after: ['campaign_blueprint'],
    milestone_name: 'Marketing Ready',
    icon: 'layers'
  },
  {
    id: 'social',
    title: 'Social Content',
    description: 'Engaging visuals tailored for Instagram, TikTok, and Pinterest.',
    status: 'coming_soon',
    weight: 15,
    estimated_outputs: 5,
    estimated_time: '1 min',
    recommended_after: ['campaign_production'],
    milestone_name: 'Social Readiness',
    icon: 'instagram'
  },
  {
    id: 'catalog',
    title: 'Product Catalog',
    description: 'Wholesale and B2B PDF catalogs.',
    status: 'coming_soon',
    weight: 10,
    estimated_outputs: 1,
    estimated_time: '1 min',
    recommended_after: ['commerce'],
    milestone_name: 'Sales Readiness',
    icon: 'book-open'
  },
  {
    id: 'video',
    title: 'Video',
    description: 'Short-form promotional video generation.',
    status: 'coming_soon',
    weight: 5,
    estimated_outputs: 1,
    estimated_time: '5 min',
    recommended_after: ['ads'],
    milestone_name: 'Video Ready',
    icon: 'video'
  }
];

class JobRegistry {
  static getJobs() {
    return JOB_REGISTRY;
  }

  static getJobById(id) {
    return JOB_REGISTRY.find(job => job.id === id);
  }

  static calculateLaunchReadiness(completedJobIds) {
    let score = 0;
    const completedSet = new Set(completedJobIds);
    for (const job of JOB_REGISTRY) {
      if (completedSet.has(job.id)) {
        score += job.weight;
      }
    }
    return Math.min(score, 100);
  }

  static getNextRecommendedAction(completedJobIds) {
    const completedSet = new Set(completedJobIds);
    
    if (!completedSet.has('original_upload')) {
        return this.getJobById('original_upload');
    }

    for (const job of JOB_REGISTRY) {
      if (completedSet.has(job.id)) continue;
      
      let dependenciesMet = true;
      if (job.recommended_after) {
          for (const dep of job.recommended_after) {
              if (!completedSet.has(dep)) {
                  dependenciesMet = false;
                  break;
              }
          }
      }
      
      if (dependenciesMet) {
          return job;
      }
    }
    return null;
  }
}

module.exports = JobRegistry;
