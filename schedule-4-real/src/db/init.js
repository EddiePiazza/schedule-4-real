/**
 * Database Initialization Script
 * Creates all necessary tables in QuestDB for Schedule 4 Real sensor data
 */

import { query } from './connection.js';
import dotenv from 'dotenv';

dotenv.config();

const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS) || 7;

const tables = [
  // Environmental sensors (from Power Strip 5)
  {
    name: 'sensors_environment',
    sql: `
      CREATE TABLE IF NOT EXISTS sensors_environment (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        temp DOUBLE,
        humi DOUBLE,
        vpd DOUBLE,
        co2 DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Soil sensors
  {
    name: 'sensors_soil',
    sql: `
      CREATE TABLE IF NOT EXISTS sensors_soil (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        sensor_id SYMBOL,
        temp_soil DOUBLE,
        humi_soil DOUBLE,
        ec_soil DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Outlet states
  {
    name: 'outlet_states',
    sql: `
      CREATE TABLE IF NOT EXISTS outlet_states (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        outlet SYMBOL,
        mode_type INT,
        is_on INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Light states
  {
    name: 'light_states',
    sql: `
      CREATE TABLE IF NOT EXISTS light_states (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        light_id SYMBOL,
        mode_type INT,
        level INT,
        is_on INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Blower states (tracks on/off and power level)
  {
    name: 'blower_states',
    sql: `
      CREATE TABLE IF NOT EXISTS blower_states (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        mode_type INT,
        level INT,
        is_on INT,
        close_co2 INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Fan state (CB devices have separate oscillating fan)
  {
    name: 'fan_states',
    sql: `
      CREATE TABLE IF NOT EXISTS fan_states (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        mode_type INT,
        level INT,
        is_on INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // System info (less frequent)
  {
    name: 'system_status',
    sql: `
      CREATE TABLE IF NOT EXISTS system_status (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        firmware_ver SYMBOL,
        wifi_rssi INT,
        uptime INT,
        mem_free INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Operation logs
  {
    name: 'operation_logs',
    sql: `
      CREATE TABLE IF NOT EXISTS operation_logs (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        event_id INT,
        event STRING,
        outlet SYMBOL,
        mode_type INT,
        value DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Socket on/off events (records only state changes)
  {
    name: 'socket_events',
    sql: `
      CREATE TABLE IF NOT EXISTS socket_events (
        timestamp TIMESTAMP,
        device_mac SYMBOL,
        socket SYMBOL,
        is_on INT
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // ============================================
  // AUTOMATION / TRIGGERS SYSTEM
  // ============================================

  // Automation flows (stores visual flow configurations)
  {
    name: 'automation_flows',
    sql: `
      CREATE TABLE IF NOT EXISTS automation_flows (
        id SYMBOL,
        name STRING,
        description STRING,
        enabled INT,
        flow_json STRING,
        created_at TIMESTAMP,
        updated_at TIMESTAMP
      ) TIMESTAMP(created_at);
    `
  },

  // Socket AI mode tracking (which sockets are controlled by automation)
  {
    name: 'socket_ai_mode',
    sql: `
      CREATE TABLE IF NOT EXISTS socket_ai_mode (
        timestamp TIMESTAMP,
        socket SYMBOL,
        ai_mode INT,
        updated_by SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Blower AI mode tracking (whether blower is controlled by automation)
  {
    name: 'blower_ai_mode',
    sql: `
      CREATE TABLE IF NOT EXISTS blower_ai_mode (
        timestamp TIMESTAMP,
        device SYMBOL,
        ai_mode INT,
        updated_by SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Fan AI mode tracking (whether fan is controlled by automation)
  {
    name: 'fan_ai_mode',
    sql: `
      CREATE TABLE IF NOT EXISTS fan_ai_mode (
        timestamp TIMESTAMP,
        device SYMBOL,
        ai_mode INT,
        updated_by SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Trigger execution logs (audit trail of automation actions)
  {
    name: 'trigger_execution_log',
    sql: `
      CREATE TABLE IF NOT EXISTS trigger_execution_log (
        timestamp TIMESTAMP,
        flow_id SYMBOL,
        flow_name STRING,
        trigger_reason STRING,
        device_mac SYMBOL,
        socket SYMBOL,
        action SYMBOL,
        result SYMBOL,
        sensor_values STRING
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // Socket custom names (user-defined names for sockets)
  {
    name: 'socket_names',
    sql: `
      CREATE TABLE IF NOT EXISTS socket_names (
        timestamp TIMESTAMP,
        socket SYMBOL,
        name STRING
      ) TIMESTAMP(timestamp);
    `
  },

  // Sensor custom names (user-defined names for soil/EC sensors)
  {
    name: 'sensor_names',
    sql: `
      CREATE TABLE IF NOT EXISTS sensor_names (
        timestamp TIMESTAMP,
        sensor_id SYMBOL,
        sensor_type SYMBOL,
        name STRING,
        plant_id STRING
      ) TIMESTAMP(timestamp);
    `
  },

  // Day/Night schedule (persists light cycle for flow period resolution)
  {
    name: 'day_night_schedule',
    sql: `
      CREATE TABLE IF NOT EXISTS day_night_schedule (
        timestamp TIMESTAMP,
        day_start STRING,
        day_end STRING,
        source SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // ============================================
  // POWER CONSUMPTION TRACKING
  // ============================================

  // Socket wattage configuration (user-defined watts per socket)
  {
    name: 'socket_wattage',
    sql: `
      CREATE TABLE IF NOT EXISTS socket_wattage (
        timestamp TIMESTAMP,
        socket SYMBOL,
        watts INT,
        cost_per_kwh DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // ============================================
  // ============================================
  // DEPRECATED TABLES (kept for historical data)
  // These tables were used by the old /grow page.
  // VPD Control now uses lab_plants for plant stage tracking.
  // Do not delete - QuestDB retains historical data.
  // ============================================

  // DEPRECATED: Grow sessions - superseded by lab_plants
  {
    name: 'grows',
    sql: `
      CREATE TABLE IF NOT EXISTS grows (
        timestamp TIMESTAMP,
        id SYMBOL,
        name STRING,
        strain STRING,
        start_date STRING,
        status SYMBOL,
        current_phase SYMBOL,
        phase_start_date STRING,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // DEPRECATED: Grow events - superseded by lab_stage_log
  {
    name: 'grow_events',
    sql: `
      CREATE TABLE IF NOT EXISTS grow_events (
        timestamp TIMESTAMP,
        grow_id SYMBOL,
        event_type SYMBOL,
        phase STRING,
        note STRING,
        data STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // ============================================
  // VPD AUTO-CALIBRATION
  // ============================================

  // Socket climate roles (cool, heat, humidify, dehumidify, circulate)
  {
    name: 'socket_climate_roles',
    sql: `
      CREATE TABLE IF NOT EXISTS socket_climate_roles (
        timestamp TIMESTAMP,
        socket SYMBOL,
        role SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // VPD auto-calibration configuration
  {
    name: 'vpd_config',
    sql: `
      CREATE TABLE IF NOT EXISTS vpd_config (
        timestamp TIMESTAMP,
        enabled BOOLEAN,
        mode SYMBOL,
        target_vpd_min DOUBLE,
        target_vpd_max DOUBLE,
        phase_targets STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // ============================================
  // DEVICE REGISTRY (autodetected by proxy)
  // ============================================

  // Known devices (proxy writes here via ILP when new devices are seen)
  {
    name: 'devices',
    sql: `
      CREATE TABLE IF NOT EXISTS devices (
        timestamp TIMESTAMP,
        mac STRING,
        device_type SYMBOL,
        custom_name STRING,
        room_id STRING,
        user_id STRING,
        firmware_ver STRING,
        first_seen TIMESTAMP,
        last_seen TIMESTAMP
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Device custom names (fast lookup table for user-defined names)
  {
    name: 'device_names',
    sql: `
      CREATE TABLE IF NOT EXISTS device_names (
        timestamp TIMESTAMP,
        mac STRING,
        custom_name STRING
      ) TIMESTAMP(timestamp);
    `
  },

  // WiFi connectivity events (tracks signal loss/recovery)
  {
    name: 'device_wifi_events',
    sql: `
      CREATE TABLE IF NOT EXISTS device_wifi_events (
        timestamp TIMESTAMP,
        mac SYMBOL,
        event_type SYMBOL,
        rssi INT,
        duration_seconds LONG
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  },

  // ============================================
  // LABORATORY / GROW JOURNAL SYSTEM
  // ============================================

  // Strain catalog
  {
    name: 'lab_strains',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_strains (
        timestamp TIMESTAMP,
        id STRING,
        name STRING,
        generation SYMBOL,
        lineage STRING,
        breeder STRING,
        seed_type SYMBOL,
        indica_ratio INT,
        expected_flowering_days INT,
        expected_thc DOUBLE,
        expected_cbd DOUBLE,
        dominant_terpenes STRING,
        grow_difficulty SYMBOL,
        description STRING,
        breeder_notes STRING,
        acquisition_date STRING,
        acquisition_source STRING,
        total_seeds INT,
        seeds_remaining INT,
        is_clone_only INT,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Seed batch inventory
  {
    name: 'lab_seed_batches',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_seed_batches (
        timestamp TIMESTAMP,
        id STRING,
        strain_id STRING,
        batch_code STRING,
        acquisition_date STRING,
        seed_count INT,
        seeds_popped INT,
        germination_rate DOUBLE,
        storage_location STRING,
        storage_conditions STRING,
        source_type SYMBOL,
        notes STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Individual plant tracking (core entity)
  {
    name: 'lab_plants',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_plants (
        timestamp TIMESTAMP,
        id STRING,
        strain_id STRING,
        seed_batch_id STRING,
        zone_id STRING,
        plant_code STRING,
        pheno_label STRING,
        origin_type SYMBOL,
        parent_plant_id STRING,
        project_goal SYMBOL,
        status SYMBOL,
        selection_status SYMBOL,
        cull_reason STRING,
        cull_date STRING,
        is_keeper INT,
        keeper_notes STRING,
        sex SYMBOL,
        sex_confirmed_date STRING,
        date_started STRING,
        date_to_veg STRING,
        date_to_flower STRING,
        date_harvested STRING,
        current_week INT,
        current_day INT,
        total_veg_days INT,
        total_flower_days INT,
        container_size DOUBLE,
        grow_medium SYMBOL,
        nutrients_type SYMBOL,
        training_methods STRING,
        final_height_cm DOUBLE,
        final_score DOUBLE,
        hof_category STRING,
        hof_notes STRING,
        breeding_project_id STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Stage transition log
  {
    name: 'lab_stage_log',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_stage_log (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        stage SYMBOL,
        started_at STRING,
        ended_at STRING,
        duration_days INT,
        transition_data STRING,
        notes STRING,
        stage_score DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Plant observations (journal entries)
  {
    name: 'lab_observations',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_observations (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        observed_at STRING,
        week_number INT,
        day_number INT,
        stage SYMBOL,
        obs_type SYMBOL,
        height_cm DOUBLE,
        health_score INT,
        vigor_score INT,
        pest_issues INT,
        pest_details STRING,
        disease_issues INT,
        disease_details STRING,
        deficiency_issues INT,
        deficiency_details STRING,
        watering_notes STRING,
        feeding_notes STRING,
        training_applied STRING,
        general_notes STRING,
        photos STRING,
        checklist_data STRING,
        env_snapshot_id STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Phenotype trait characterization
  {
    name: 'lab_phenotype_traits',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_phenotype_traits (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        evaluated_at STRING,
        evaluation_stage SYMBOL,
        germination_traits STRING,
        seedling_traits STRING,
        leaf_traits STRING,
        stalk_traits STRING,
        aroma_traits STRING,
        growth_habit_traits STRING,
        clone_traits STRING,
        reveg_traits STRING,
        flowering_traits STRING,
        flower_aroma_traits STRING,
        resistance_traits STRING,
        problem_traits STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Plant scoring evaluations
  {
    name: 'lab_plant_scores',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_plant_scores (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        scored_at STRING,
        scoring_stage SYMBOL,
        scoring_profile_id STRING,
        scorer_notes STRING,
        germ_score INT,
        seedling_vigor_score INT,
        veg_vigor_score INT,
        flower_vigor_score INT,
        stalk_structure_score INT,
        branching_score INT,
        node_spacing_score INT,
        overall_structure_score INT,
        pest_resistance_score INT,
        disease_resistance_score INT,
        stress_tolerance_score INT,
        hermie_resistance_score INT,
        bud_density_score INT,
        resin_production_score INT,
        calyx_leaf_ratio_score INT,
        yield_score INT,
        aroma_intensity_score INT,
        aroma_complexity_score INT,
        aroma_appeal_score INT,
        clone_ease_score INT,
        consistency_score INT,
        clone_vigor_score INT,
        vigor_health_total DOUBLE,
        structure_total DOUBLE,
        resistance_total DOUBLE,
        flower_production_total DOUBLE,
        aroma_total DOUBLE,
        clone_stability_total DOUBLE,
        final_score DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Harvest data
  {
    name: 'lab_harvest_data',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_harvest_data (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        harvest_date STRING,
        days_from_germ INT,
        days_flowering INT,
        final_height_cm DOUBLE,
        wet_weight_g DOUBLE,
        dry_weight_g DOUBLE,
        trim_weight_g DOUBLE,
        premium_bud_g DOUBLE,
        medium_bud_g DOUBLE,
        smalls_g DOUBLE,
        yield_per_plant_g DOUBLE,
        yield_per_watt DOUBLE,
        yield_per_m2 DOUBLE,
        wet_dry_ratio DOUBLE,
        trichome_state STRING,
        main_colas INT,
        bag_appeal_score INT,
        cure_start_date STRING,
        cure_duration_days INT,
        cure_aroma_intensity INT,
        cure_aroma_complexity INT,
        cure_aroma_appeal INT,
        cure_aroma_profile STRING,
        smoke_smoothness INT,
        dry_conditions STRING,
        photos STRING,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Cull/discard records
  {
    name: 'lab_cull_records',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_cull_records (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        cull_date STRING,
        stage_at_cull SYMBOL,
        reason_primary SYMBOL,
        reasons_secondary STRING,
        description STRING,
        clones_taken INT,
        pollen_saved INT,
        photo_evidence STRING,
        final_score_at_cull DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Clone tracking
  {
    name: 'lab_clone_records',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_clone_records (
        timestamp TIMESTAMP,
        id STRING,
        mother_plant_id STRING,
        clone_plant_id STRING,
        cut_date STRING,
        rooting_method SYMBOL,
        first_roots_date STRING,
        transplant_date STRING,
        rooting_days INT,
        success INT,
        vigor_post_transplant SYMBOL,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Breeding projects
  {
    name: 'lab_breeding_projects',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_breeding_projects (
        timestamp TIMESTAMP,
        id STRING,
        name STRING,
        code STRING,
        project_type SYMBOL,
        status SYMBOL,
        primary_goal STRING,
        target_traits STRING,
        traits_to_avoid STRING,
        female_strain_id STRING,
        male_strain_id STRING,
        female_plant_id STRING,
        male_plant_id STRING,
        started_at STRING,
        target_completion STRING,
        completed_at STRING,
        total_seeds_produced INT,
        seeds_tested INT,
        successful_phenos INT,
        notes STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Breeding crosses
  {
    name: 'lab_breeding_crosses',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_breeding_crosses (
        timestamp TIMESTAMP,
        id STRING,
        project_id STRING,
        cross_code STRING,
        generation SYMBOL,
        female_plant_id STRING,
        male_plant_id STRING,
        is_selfed INT,
        selfed_plant_id STRING,
        pollination_method SYMBOL,
        pollination_date STRING,
        seed_harvest_date STRING,
        branches_pollinated INT,
        seeds_produced INT,
        seed_viability_rate DOUBLE,
        resulting_batch_id STRING,
        storage_location STRING,
        storage_conditions STRING,
        progeny_notes STRING,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Pollen storage inventory
  {
    name: 'lab_pollen_storage',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_pollen_storage (
        timestamp TIMESTAMP,
        id STRING,
        male_plant_id STRING,
        strain_id STRING,
        batch_code STRING,
        collection_date STRING,
        quantity_grams DOUBLE,
        viability_at_collection DOUBLE,
        last_viability_test STRING,
        current_viability DOUBLE,
        storage_method SYMBOL,
        storage_location STRING,
        desiccant_type STRING,
        container_type STRING,
        status SYMBOL,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Lineage tree
  {
    name: 'lab_lineage',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_lineage (
        timestamp TIMESTAMP,
        id STRING,
        strain_id STRING,
        plant_id STRING,
        mother_id STRING,
        father_id STRING,
        generation_depth INT,
        generation_label SYMBOL,
        is_root INT,
        display_name STRING,
        display_color STRING,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Scoring profiles (weight configurations)
  {
    name: 'lab_scoring_profiles',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_scoring_profiles (
        timestamp TIMESTAMP,
        id STRING,
        name STRING,
        description STRING,
        vigor_weight DOUBLE,
        structure_weight DOUBLE,
        resistance_weight DOUBLE,
        production_weight DOUBLE,
        aroma_weight DOUBLE,
        clonability_weight DOUBLE,
        vigor_internal STRING,
        structure_internal STRING,
        resistance_internal STRING,
        production_internal STRING,
        aroma_internal STRING,
        clonability_internal STRING,
        is_default INT,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Media files (photos/videos)
  {
    name: 'lab_media',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_media (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        observation_id STRING,
        file_path STRING,
        file_name STRING,
        file_type SYMBOL,
        file_size INT,
        caption STRING,
        stage SYMBOL,
        is_cover INT,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Notifications and alerts
  {
    name: 'lab_notifications',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_notifications (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        source SYMBOL,
        level SYMBOL,
        notification_type STRING,
        trigger_name STRING,
        stage SYMBOL,
        title STRING,
        message STRING,
        action_label STRING,
        action_route STRING,
        read_at STRING,
        acknowledged INT,
        resolved INT,
        resolved_action STRING,
        resolved_at STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Plant zone assignments (Spider Farmer integration)
  {
    name: 'lab_plant_zones',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_plant_zones (
        timestamp TIMESTAMP,
        id STRING,
        plant_id STRING,
        zone_id STRING,
        zone_name STRING,
        device_mac STRING,
        assigned_at STRING,
        removed_at STRING,
        notes STRING
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Environmental snapshots (captured with observations)
  {
    name: 'lab_env_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_env_snapshots (
        timestamp TIMESTAMP,
        id STRING,
        observation_id STRING,
        plant_id STRING,
        zone_id STRING,
        temp_current DOUBLE,
        temp_avg_24h DOUBLE,
        temp_min_24h DOUBLE,
        temp_max_24h DOUBLE,
        humi_current DOUBLE,
        humi_avg_24h DOUBLE,
        vpd_current DOUBLE,
        vpd_avg_24h DOUBLE,
        co2_current DOUBLE,
        light_level INT,
        light_mode SYMBOL,
        light_hours INT,
        dli_estimated DOUBLE,
        gdd_accumulated DOUBLE,
        stress_index DOUBLE
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Stage profiles (target environment per stage)
  {
    name: 'lab_stage_profiles',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_stage_profiles (
        timestamp TIMESTAMP,
        id STRING,
        stage SYMBOL,
        name STRING,
        temp_day_min DOUBLE,
        temp_day_max DOUBLE,
        temp_night_min DOUBLE,
        temp_night_max DOUBLE,
        humidity_min DOUBLE,
        humidity_max DOUBLE,
        vpd_min DOUBLE,
        vpd_max DOUBLE,
        dli_target DOUBLE,
        light_hours INT,
        co2_target DOUBLE,
        notes STRING,
        is_default INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Grow rooms / cultivation zones
  {
    name: 'lab_grow_rooms',
    sql: `
      CREATE TABLE IF NOT EXISTS lab_grow_rooms (
        timestamp TIMESTAMP,
        id STRING,
        name STRING,
        description STRING,
        room_type SYMBOL,
        dimensions_cm STRING,
        cover_color STRING,
        icon STRING,
        layout_data STRING,
        device_macs STRING,
        light_ids STRING,
        outlet_ids STRING,
        sensor_ids STRING,
        active_plant_ids STRING,
        environment_profile STRING,
        status SYMBOL,
        sort_order INT,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // IP Camera configurations
  {
    name: 'cameras',
    sql: `
      CREATE TABLE IF NOT EXISTS cameras (
        timestamp TIMESTAMP,
        id STRING,
        name STRING,
        protocol SYMBOL,
        host STRING,
        port INT,
        path STRING,
        username STRING,
        password STRING,
        enabled INT,
        sort_order INT,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Camera timelapse schedules
  {
    name: 'camera_timelapse_schedules',
    sql: `
      CREATE TABLE IF NOT EXISTS camera_timelapse_schedules (
        timestamp TIMESTAMP,
        id STRING,
        camera_id STRING,
        enabled INT,
        interval_minutes INT,
        start_time STRING,
        end_time STRING,
        days_active STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // Camera overlay settings (per-camera text overlay for photos)
  {
    name: 'camera_overlay_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS camera_overlay_settings (
        timestamp TIMESTAMP,
        camera_id STRING,
        enabled INT,
        position STRING,
        show_date INT,
        date_format STRING,
        show_time INT,
        show_day_counter INT,
        day_counter_start STRING,
        day_counter_label STRING,
        custom_text STRING,
        font_size INT,
        text_color STRING,
        is_deleted INT
      ) TIMESTAMP(timestamp) PARTITION BY MONTH;
    `
  },

  // ============================================
  // TRACKER ROOMS (onion network room registry)
  // ============================================

  // Room registrations for the tracker — append-only, use LATEST BY room_id
  {
    name: 'tracker_rooms',
    sql: `
      CREATE TABLE IF NOT EXISTS tracker_rooms (
        timestamp TIMESTAMP,
        room_id SYMBOL,
        metadata STRING,
        entry_relay STRING,
        is_private BOOLEAN,
        federated BOOLEAN,
        source_relay STRING,
        expires_at LONG
      ) TIMESTAMP(timestamp) PARTITION BY DAY;
    `
  }
];

// Migrations to add columns to existing tables
const migrations = [
  {
    name: 'trigger_execution_log: add device_mac column',
    sql: `ALTER TABLE trigger_execution_log ADD COLUMN device_mac SYMBOL`
  }
];

async function runMigrations() {
  console.log('Running migrations...');
  for (const migration of migrations) {
    try {
      await query(migration.sql);
      console.log(`  ✓ ${migration.name}`);
    } catch (err) {
      // Ignore if column already exists
      if (err.message.includes('already exists') || err.message.includes('Duplicate column')) {
        console.log(`  - ${migration.name} (already applied)`);
      } else if (err.message.includes('does not exist')) {
        console.log(`  - ${migration.name} (table not created yet)`);
      } else {
        console.error(`  ✗ ${migration.name}:`, err.message);
      }
    }
  }
}

async function initDatabase() {
  console.log('='.repeat(60));
  console.log('Schedule 4 Real - Database Initialization');
  console.log('='.repeat(60));
  console.log(`Retention: ${RETENTION_DAYS} days`);
  console.log('');

  for (const table of tables) {
    try {
      console.log(`Creating table: ${table.name}...`);
      await query(table.sql);
      console.log(`  ✓ ${table.name} created/verified`);
    } catch (err) {
      // QuestDB may return error if table exists, which is fine
      if (err.message.includes('already exists')) {
        console.log(`  ✓ ${table.name} already exists`);
      } else {
        console.error(`  ✗ Error creating ${table.name}:`, err.message);
      }
    }
  }

  // Run migrations for existing tables
  console.log('');
  await runMigrations();

  console.log('');
  console.log('Database initialization complete!');
  console.log('');
  console.log('Tables created:');
  tables.forEach(t => console.log(`  - ${t.name}`));
  console.log('');
  console.log(`Note: QuestDB auto-manages partitions. Old data (>${RETENTION_DAYS} days)`);
  console.log('can be cleaned manually or via scheduled job.');
  console.log('');
  console.log('To clean old data, run:');
  console.log(`  ALTER TABLE sensors_environment DROP PARTITION`);
  console.log(`    WHERE timestamp < dateadd('d', -${RETENTION_DAYS}, now());`);

  process.exit(0);
}

initDatabase().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
