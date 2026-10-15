export const ENCODINGS = [
    {
        "instructionId": "ldnt1sh_z_p_ar",
        "encodingId": "ldnt1sh_z_p_ar_d_64_unscaled",
        "mnemonic": "LDNT1SH",
        "className": "64-bit unscaled offset",
        "fileName": "ldnt1sh_z_p_ar.xml",
        "mask": 4292927488,
        "value": 3296755712,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
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
            "FEAT_SVE2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-signed-nontemporal-vector-base-load"
    },
    {
        "instructionId": "ldnt1sh_z_p_ar",
        "encodingId": "ldnt1sh_z_p_ar_s_x32_unscaled",
        "mnemonic": "LDNT1SH",
        "className": "32-bit unscaled offset",
        "fileName": "ldnt1sh_z_p_ar.xml",
        "mask": 4292927488,
        "value": 2223013888,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
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
            "FEAT_SVE2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-signed-nontemporal-vector-base-load"
    }
];
