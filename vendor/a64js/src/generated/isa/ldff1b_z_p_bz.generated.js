export const ENCODINGS = [
    {
        "instructionId": "ldff1b_z_p_bz",
        "encodingId": "ldff1b_z_p_bz_d_64_unscaled",
        "mnemonic": "LDFF1B",
        "className": "64-bit unscaled offset",
        "fileName": "ldff1b_z_p_bz.xml",
        "mask": 4292927488,
        "value": 3292585984,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1b_z_p_bz",
        "encodingId": "ldff1b_z_p_bz_d_x32_unscaled",
        "mnemonic": "LDFF1B",
        "className": "32-bit unpacked unscaled offset",
        "fileName": "ldff1b_z_p_bz.xml",
        "mask": 4288733184,
        "value": 3288358912,
        "bitCount": 13,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1b_z_p_bz",
        "encodingId": "ldff1b_z_p_bz_s_x32_unscaled",
        "mnemonic": "LDFF1B",
        "className": "32-bit unscaled offset",
        "fileName": "ldff1b_z_p_bz.xml",
        "mask": 4288733184,
        "value": 2214617088,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    }
];
